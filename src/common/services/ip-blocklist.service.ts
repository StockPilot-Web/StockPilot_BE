import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../errors/app-error';
import { logger } from '../logger';
import { AuditLogService } from './audit-log.service';
import { ipFamily, isLoopback, normalizeIp, parseIpOrCidr, ParsedIpRange, rangeContains } from '../utils/ip-address';

/**
 * Admin-managed IP blocklist (IP or CIDR range), stored as one JSON row in `system_settings`
 * so it needs no migration. Checked on every request by ipBlockMiddleware through a short cache.
 */
export const IP_BLOCKLIST_SETTING_KEY = 'ops.security.ipBlocklist';
export const IP_BLOCKED_ACTION = 'IP_BLOCKED';
export const IP_UNBLOCKED_ACTION = 'IP_UNBLOCKED';
export const IP_BLOCK_ENTITY = 'IP_BLOCKLIST';
export const MAX_IP_BLOCK_ENTRIES = 1000;
const CACHE_TTL_MS = 10_000;

const entrySchema = z.object({
  id: z.string().min(1),
  cidr: z.string().min(1),
  reason: z.string(),
  createdAt: z.string(),
  createdById: z.number().int().nullable(),
  expiresAt: z.string().nullable(),
});
const valueSchema = z.object({ entries: z.array(z.unknown()) });

export type IpBlockEntry = z.infer<typeof entrySchema>;

type BlocklistDb = Pick<PrismaClient, 'systemSetting'> | Prisma.TransactionClient;
type BlocklistWriteDb = Pick<PrismaClient, '$transaction'>;

export interface IpBlockActor {
  userId: number;
  /** Client IP of the admin (req.ip); an entry covering it is refused to avoid self-lockout. */
  ipAddress?: string | null;
  /** Address of the proxy hop the request came through (req.socket.remoteAddress). */
  peerAddress?: string | null;
  userAgent?: string | null;
}

export interface AddIpBlockInput {
  ip: string;
  reason: string;
  /** Omit or null for a permanent block. */
  expiresInHours?: number | null;
}

interface CacheState {
  list: net.BlockList;
  entries: IpBlockEntry[];
  loadedAt: number;
  /** Earliest expiry among loaded entries: the cache is rebuilt once it passes. */
  nextExpiryAt: number | null;
}

function isActive(entry: IpBlockEntry, now = Date.now()) {
  return !entry.expiresAt || new Date(entry.expiresAt).getTime() > now;
}

function parseEntries(raw: unknown): IpBlockEntry[] {
  const value = valueSchema.safeParse(raw);
  if (!value.success) return [];
  const entries: IpBlockEntry[] = [];
  for (const item of value.data.entries) {
    const parsed = entrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

function tryParse(cidr: string): ParsedIpRange | null {
  try {
    return parseIpOrCidr(cidr);
  } catch {
    return null;
  }
}

function buildList(cidrs: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const range = tryParse(cidr);
    if (range) list.addSubnet(range.address, range.prefix, range.family);
  }
  return list;
}

/** Emergency list from the BLOCKED_IPS env var (comma separated), read once at startup. */
function envEntries(): string[] {
  return String(process.env.BLOCKED_IPS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      if (tryParse(item)) return true;
      logger.warn('blocked_ips_env_invalid_entry', { entry: item });
      return false;
    });
}

export class IpBlocklistService {
  private static cache: CacheState | null = null;
  private static loading: Promise<CacheState> | null = null;
  private static envCidrs: string[] | null = null;
  private static envList: net.BlockList | null = null;

  /** Drops the cache so the next request reloads (called after every write, and by tests). */
  static invalidate() {
    this.cache = null;
    this.loading = null;
    this.envCidrs = null;
    this.envList = null;
  }

  private static envBlockList() {
    if (!this.envList) {
      this.envCidrs = envEntries();
      this.envList = buildList(this.envCidrs);
    }
    return this.envList;
  }

  private static async load(db: BlocklistDb): Promise<CacheState> {
    const row = await db.systemSetting.findUnique({ where: { key: IP_BLOCKLIST_SETTING_KEY } });
    const now = Date.now();
    const active = parseEntries(row?.valueJson).filter((entry) => isActive(entry, now));
    const expiries = active.filter((e) => e.expiresAt).map((e) => new Date(e.expiresAt as string).getTime());
    return {
      list: buildList(active.map((entry) => entry.cidr)),
      entries: active,
      loadedAt: now,
      nextExpiryAt: expiries.length ? Math.min(...expiries) : null,
    };
  }

  private static async current(db: BlocklistDb): Promise<CacheState | null> {
    const now = Date.now();
    const cache = this.cache;
    const fresh = cache && now - cache.loadedAt < CACHE_TTL_MS && (cache.nextExpiryAt === null || now < cache.nextExpiryAt);
    if (fresh) return cache;

    if (!this.loading) {
      this.loading = this.load(db)
        .then((state) => {
          this.cache = state;
          return state;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    try {
      return await this.loading;
    } catch (error: any) {
      // Fail open: a database hiccup must not lock every shop out. Keep the last good list.
      logger.warn('ip_blocklist_load_failed', { message: error?.message });
      return this.cache;
    }
  }

  /** True when the request IP is on the admin blocklist or the BLOCKED_IPS env list. */
  static async isBlocked(rawIp: string | null | undefined, db: BlocklistDb = defaultPrisma): Promise<boolean> {
    const ip = normalizeIp(rawIp);
    if (!ip) return false;
    const family = ipFamily(ip);
    if (this.envBlockList().check(ip, family)) return true;
    const state = await this.current(db);
    return state ? state.list.check(ip, family) : false;
  }

  /** Full list for the admin screen, including expired entries (shown greyed out) and env entries. */
  static async list(db: BlocklistDb = defaultPrisma) {
    const row = await db.systemSetting.findUnique({ where: { key: IP_BLOCKLIST_SETTING_KEY } });
    const now = Date.now();
    this.envBlockList();
    const entries = parseEntries(row?.valueJson)
      .map((entry) => ({ ...entry, active: isActive(entry, now) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      entries,
      activeCount: entries.filter((e) => e.active).length,
      // Read-only: set in the server's .env, removable only there.
      envEntries: [...(this.envCidrs ?? [])],
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /**
   * Read-modify-write with optimistic concurrency on `updatedAt`: two admins blocking at the same
   * moment cannot silently overwrite each other's entry. The audit log is written in the same transaction.
   */
  private static async mutate(
    db: BlocklistWriteDb,
    actor: IpBlockActor,
    change: (entries: IpBlockEntry[]) => { entries: IpBlockEntry[]; audit: { action: string; entityId: string; before: unknown; after: unknown } }
  ) {
    const result = await db.$transaction(async (tx) => {
      const row = await tx.systemSetting.findUnique({ where: { key: IP_BLOCKLIST_SETTING_KEY } });
      const now = Date.now();
      // Expired entries are pruned on every write so the row does not grow forever.
      const existing = parseEntries(row?.valueJson).filter((entry) => isActive(entry, now));
      const { entries, audit } = change(existing);
      const valueJson = { entries } as unknown as Prisma.InputJsonValue;

      if (row) {
        const updated = await tx.systemSetting.updateMany({
          where: { key: IP_BLOCKLIST_SETTING_KEY, updatedAt: row.updatedAt },
          data: { valueJson, updatedById: actor.userId },
        });
        if (updated.count === 0) {
          throw new ConflictError('Danh sách chặn IP vừa được thay đổi bởi người khác. Vui lòng tải lại và thử lại.');
        }
      } else {
        try {
          await tx.systemSetting.create({
            data: {
              key: IP_BLOCKLIST_SETTING_KEY,
              valueJson,
              description: 'Danh sách IP/dải IP bị chặn truy cập (chỉ admin)',
              updatedById: actor.userId,
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new ConflictError('Danh sách chặn IP vừa được tạo bởi người khác. Vui lòng thử lại.');
          }
          throw error;
        }
      }

      await AuditLogService.create(tx, {
        userId: actor.userId,
        action: audit.action,
        entityType: IP_BLOCK_ENTITY,
        entityId: audit.entityId,
        beforeJson: audit.before,
        afterJson: audit.after,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      return audit.after;
    });
    this.invalidate();
    return result;
  }

  static async add(input: AddIpBlockInput, actor: IpBlockActor, db: BlocklistWriteDb = defaultPrisma) {
    let range: ParsedIpRange;
    try {
      range = parseIpOrCidr(input.ip);
    } catch (error: any) {
      throw new ValidationError(error.message);
    }

    // Self-lockout guards: never block loopback, the proxy hop (would block every visitor when
    // trust proxy is misconfigured) or the admin's own current IP.
    if (isLoopback(range.address) || ['127.0.0.1', '::1'].some((ip) => rangeContains(range, ip))) {
      throw new ValidationError('Không thể chặn địa chỉ loopback của máy chủ');
    }
    if (actor.peerAddress && rangeContains(range, actor.peerAddress)) {
      throw new ValidationError('Dải IP này chứa địa chỉ của proxy/Nginx phía trước backend — chặn sẽ khóa toàn bộ người dùng');
    }
    if (actor.ipAddress && rangeContains(range, actor.ipAddress)) {
      throw new ValidationError('Dải IP này chứa chính địa chỉ IP bạn đang dùng — chặn sẽ khóa bạn khỏi hệ thống');
    }

    const now = new Date();
    const entry: IpBlockEntry = {
      id: randomUUID(),
      cidr: range.cidr,
      reason: input.reason.trim(),
      createdAt: now.toISOString(),
      createdById: actor.userId,
      expiresAt: input.expiresInHours ? new Date(now.getTime() + input.expiresInHours * 3600_000).toISOString() : null,
    };

    return this.mutate(db, actor, (entries) => {
      if (entries.some((existing) => existing.cidr === entry.cidr)) {
        throw new ConflictError(`${entry.cidr} đã có trong danh sách chặn`);
      }
      if (entries.length >= MAX_IP_BLOCK_ENTRIES) {
        throw new ConflictError(`Danh sách chặn đã đủ ${MAX_IP_BLOCK_ENTRIES} mục — hãy gộp thành dải CIDR hoặc gỡ bớt`);
      }
      return {
        entries: [...entries, entry],
        audit: { action: IP_BLOCKED_ACTION, entityId: entry.cidr, before: null, after: entry },
      };
    });
  }

  static async remove(id: string, reason: string, actor: IpBlockActor, db: BlocklistWriteDb = defaultPrisma) {
    return this.mutate(db, actor, (entries) => {
      const target = entries.find((entry) => entry.id === id);
      if (!target) throw new NotFoundError('Không tìm thấy mục chặn IP (có thể đã hết hạn hoặc đã được gỡ)');
      return {
        entries: entries.filter((entry) => entry.id !== id),
        audit: { action: IP_UNBLOCKED_ACTION, entityId: target.cidr, before: target, after: { ...target, removedReason: reason.trim() } },
      };
    });
  }
}
