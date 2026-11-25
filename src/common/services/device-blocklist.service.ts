import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../errors/app-error';
import { logger } from '../logger';
import { AuditLogService } from './audit-log.service';
import { DeviceBlockKind, DeviceIdentity, normalizeDeviceValue } from '../utils/device-identity';

/**
 * Admin-managed device blocklist (browser device id or hardware fingerprint), stored as one JSON row
 * in `system_settings` (no migration). Same design as IpBlocklistService: short cache, fail open,
 * optimistic concurrency on `updatedAt`, audit log in the same transaction.
 */
export const DEVICE_BLOCKLIST_SETTING_KEY = 'ops.security.deviceBlocklist';
export const DEVICE_BLOCKED_ACTION = 'DEVICE_BLOCKED';
export const DEVICE_UNBLOCKED_ACTION = 'DEVICE_UNBLOCKED';
export const DEVICE_BLOCK_ENTITY = 'DEVICE_BLOCKLIST';
export const MAX_DEVICE_BLOCK_ENTRIES = 2000;
const CACHE_TTL_MS = 10_000;

const entrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['DEVICE', 'FINGERPRINT']),
  value: z.string().min(1),
  reason: z.string(),
  createdAt: z.string(),
  createdById: z.number().int().nullable(),
  expiresAt: z.string().nullable(),
});
export type DeviceBlockEntry = z.infer<typeof entrySchema>;

type Db = Pick<PrismaClient, 'systemSetting'> | Prisma.TransactionClient;
type WriteDb = Pick<PrismaClient, '$transaction'>;

export interface DeviceBlockActor {
  userId: number;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** The admin's own device, so they cannot lock themselves out. */
  device?: DeviceIdentity;
}

export interface AddDeviceBlockInput {
  kind: DeviceBlockKind;
  value: string;
  reason: string;
  expiresInHours?: number | null;
}

interface CacheState {
  devices: Set<string>;
  fingerprints: Set<string>;
  loadedAt: number;
  nextExpiryAt: number | null;
}

const isActive = (entry: DeviceBlockEntry, now = Date.now()) => !entry.expiresAt || new Date(entry.expiresAt).getTime() > now;

function parseEntries(raw: unknown): DeviceBlockEntry[] {
  const list = (raw as { entries?: unknown[] } | null)?.entries;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const parsed = entrySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export class DeviceBlocklistService {
  private static cache: CacheState | null = null;
  private static loading: Promise<CacheState> | null = null;

  static invalidate() {
    this.cache = null;
    this.loading = null;
  }

  private static async load(db: Db): Promise<CacheState> {
    const row = await db.systemSetting.findUnique({ where: { key: DEVICE_BLOCKLIST_SETTING_KEY } });
    const now = Date.now();
    const active = parseEntries(row?.valueJson).filter((e) => isActive(e, now));
    const expiries = active.filter((e) => e.expiresAt).map((e) => new Date(e.expiresAt as string).getTime());
    return {
      devices: new Set(active.filter((e) => e.kind === 'DEVICE').map((e) => e.value)),
      fingerprints: new Set(active.filter((e) => e.kind === 'FINGERPRINT').map((e) => e.value)),
      loadedAt: now,
      nextExpiryAt: expiries.length ? Math.min(...expiries) : null,
    };
  }

  private static async current(db: Db): Promise<CacheState | null> {
    const now = Date.now();
    const cache = this.cache;
    if (cache && now - cache.loadedAt < CACHE_TTL_MS && (cache.nextExpiryAt === null || now < cache.nextExpiryAt)) return cache;
    if (!this.loading) {
      this.loading = this.load(db)
        .then((state) => (this.cache = state))
        .finally(() => {
          this.loading = null;
        });
    }
    try {
      return await this.loading;
    } catch (error: any) {
      logger.warn('device_blocklist_load_failed', { message: error?.message });
      return this.cache;
    }
  }

  /** Which signal matched, or null. Requests without device headers are never blocked here. */
  static async match(identity: DeviceIdentity, db: Db = defaultPrisma): Promise<DeviceBlockKind | null> {
    if (!identity.deviceId && !identity.fingerprint) return null;
    const state = await this.current(db);
    if (!state) return null;
    if (identity.deviceId && state.devices.has(identity.deviceId)) return 'DEVICE';
    if (identity.fingerprint && state.fingerprints.has(identity.fingerprint)) return 'FINGERPRINT';
    return null;
  }

  static async list(db: Db = defaultPrisma) {
    const row = await db.systemSetting.findUnique({ where: { key: DEVICE_BLOCKLIST_SETTING_KEY } });
    const now = Date.now();
    const entries = parseEntries(row?.valueJson)
      .map((e) => ({ ...e, active: isActive(e, now) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { entries, activeCount: entries.filter((e) => e.active).length, updatedAt: row?.updatedAt ?? null };
  }

  private static async mutate(
    db: WriteDb,
    actor: DeviceBlockActor,
    change: (entries: DeviceBlockEntry[]) => { entries: DeviceBlockEntry[]; audit: { action: string; entityId: string; before: unknown; after: unknown } }
  ) {
    const result = await db.$transaction(async (tx) => {
      const row = await tx.systemSetting.findUnique({ where: { key: DEVICE_BLOCKLIST_SETTING_KEY } });
      const existing = parseEntries(row?.valueJson).filter((e) => isActive(e));
      const { entries, audit } = change(existing);
      const valueJson = { entries } as unknown as Prisma.InputJsonValue;
      if (row) {
        const updated = await tx.systemSetting.updateMany({
          where: { key: DEVICE_BLOCKLIST_SETTING_KEY, updatedAt: row.updatedAt },
          data: { valueJson, updatedById: actor.userId },
        });
        if (updated.count === 0) {
          throw new ConflictError('Danh sách chặn thiết bị vừa được thay đổi bởi người khác. Vui lòng tải lại và thử lại.');
        }
      } else {
        try {
          await tx.systemSetting.create({
            data: { key: DEVICE_BLOCKLIST_SETTING_KEY, valueJson, description: 'Danh sách thiết bị bị chặn (chỉ admin)', updatedById: actor.userId },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new ConflictError('Danh sách chặn thiết bị vừa được tạo bởi người khác. Vui lòng thử lại.');
          }
          throw error;
        }
      }
      await AuditLogService.create(tx, {
        userId: actor.userId,
        action: audit.action,
        entityType: DEVICE_BLOCK_ENTITY,
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

  static async add(input: AddDeviceBlockInput, actor: DeviceBlockActor, db: WriteDb = defaultPrisma) {
    const value = normalizeDeviceValue(input.kind, input.value);
    if (!value) {
      throw new ValidationError(input.kind === 'DEVICE' ? 'Mã thiết bị không hợp lệ' : 'Vân tay phần cứng không hợp lệ (chuỗi hex 32–64 ký tự)');
    }
    const own = input.kind === 'DEVICE' ? actor.device?.deviceId : actor.device?.fingerprint;
    if (own && own === value) {
      throw new ValidationError('Đây là thiết bị bạn đang dùng — chặn sẽ khóa bạn khỏi hệ thống');
    }
    const now = new Date();
    const entry: DeviceBlockEntry = {
      id: randomUUID(),
      kind: input.kind,
      value,
      reason: input.reason.trim(),
      createdAt: now.toISOString(),
      createdById: actor.userId,
      expiresAt: input.expiresInHours ? new Date(now.getTime() + input.expiresInHours * 3600_000).toISOString() : null,
    };
    return this.mutate(db, actor, (entries) => {
      if (entries.some((e) => e.kind === entry.kind && e.value === entry.value)) throw new ConflictError('Thiết bị này đã có trong danh sách chặn');
      if (entries.length >= MAX_DEVICE_BLOCK_ENTRIES) throw new ConflictError(`Danh sách chặn đã đủ ${MAX_DEVICE_BLOCK_ENTRIES} mục`);
      return { entries: [...entries, entry], audit: { action: DEVICE_BLOCKED_ACTION, entityId: `${entry.kind}:${entry.value}`.slice(0, 100), before: null, after: entry } };
    });
  }

  static async remove(id: string, reason: string, actor: DeviceBlockActor, db: WriteDb = defaultPrisma) {
    return this.mutate(db, actor, (entries) => {
      const target = entries.find((e) => e.id === id);
      if (!target) throw new NotFoundError('Không tìm thấy mục chặn thiết bị (có thể đã hết hạn hoặc đã được gỡ)');
      return {
        entries: entries.filter((e) => e.id !== id),
        audit: {
          action: DEVICE_UNBLOCKED_ACTION,
          entityId: `${target.kind}:${target.value}`.slice(0, 100),
          before: target,
          after: { ...target, removedReason: reason.trim() },
        },
      };
    });
  }
}
