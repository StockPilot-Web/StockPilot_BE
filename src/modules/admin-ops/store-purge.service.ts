import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '../../common/errors/app-error';
import { logger } from '../../common/logger';
import { AuditLogService } from '../../common/services/audit-log.service';
import { DeviceBlocklistService } from '../../common/services/device-blocklist.service';
import { IpBlocklistService } from '../../common/services/ip-blocklist.service';
import { DeviceIdentity, normalizeDeviceValue } from '../../common/utils/device-identity';
import { normalizeIp } from '../../common/utils/ip-address';
import { comparePassword } from '../../common/utils/password';
import type { RequestMeta } from './admin-ops.service';

export const STORE_PURGED_ACTION = 'STORE_PURGED';
/** Written by AuthService.registerOwner with the sign-up request's IP (column) and device (afterJson). */
const STORE_REGISTERED_ACTION = 'STORE_REGISTERED';

/**
 * Business records that make a store "real". A store with any of these is never deleted:
 * deleting a store cascades to every store-owned table, including the immutable stock ledger.
 */
const ACTIVITY_CHECKS = {
  orders: (tx: Prisma.TransactionClient, storeId: number) => tx.order.count({ where: { storeId } }),
  payments: (tx: Prisma.TransactionClient, storeId: number) => tx.payment.count({ where: { storeId } }),
  returnOrders: (tx: Prisma.TransactionClient, storeId: number) => tx.returnOrder.count({ where: { storeId } }),
  stockMovements: (tx: Prisma.TransactionClient, storeId: number) => tx.stockMovement.count({ where: { storeId } }),
  historicalSales: (tx: Prisma.TransactionClient, storeId: number) => tx.historicalSale.count({ where: { storeId } }),
  stockTakes: (tx: Prisma.TransactionClient, storeId: number) => tx.stockTake.count({ where: { storeId } }),
  importJobs: (tx: Prisma.TransactionClient, storeId: number) => tx.importJob.count({ where: { storeId } }),
  supportTickets: (tx: Prisma.TransactionClient, storeId: number) => tx.supportTicket.count({ where: { storeId } }),
  paymentConfigs: (tx: Prisma.TransactionClient, storeId: number) => tx.storePaymentConfig.count({ where: { storeId } }),
} as const;

export type ActivityKey = keyof typeof ACTIVITY_CHECKS;

export const ACTIVITY_LABELS: Record<ActivityKey, string> = {
  orders: 'đơn hàng',
  payments: 'thanh toán',
  returnOrders: 'phiếu trả hàng',
  stockMovements: 'biến động kho',
  historicalSales: 'dữ liệu bán hàng lịch sử',
  stockTakes: 'phiếu kiểm kê',
  importJobs: 'lượt nhập file',
  supportTickets: 'yêu cầu hỗ trợ',
  paymentConfigs: 'cấu hình thanh toán',
};

export interface PurgeStoresInput {
  storeIds: number[];
  /** Required unless dryRun (enforced by purgeStoresSchema and re-checked here). */
  reason?: string;
  actorPassword?: string;
  /** true = read-only preview of what would be deleted; no password needed. */
  dryRun?: boolean;
  /** Permanently block the IPs / devices recorded at sign-up for the stores that were actually deleted. */
  blockCreators?: boolean;
}

export interface PurgeActor extends RequestMeta {
  userId: number;
  /** Proxy hop (req.socket.remoteAddress) and the admin's own device: used by the self-lockout guards. */
  peerAddress?: string | null;
  device?: DeviceIdentity;
}

/** What the system recorded about the request that created the store (STORE_REGISTERED audit log). */
export interface StoreCreator {
  ipAddress: string | null;
  deviceId: string | null;
  fingerprint: string | null;
  recordedAt: string;
}

export interface PurgeResultItem {
  storeId: number;
  name?: string;
  code?: string;
  status: 'DELETED' | 'DELETABLE' | 'SKIPPED' | 'NOT_FOUND' | 'FAILED';
  reason?: string;
  activity?: Partial<Record<ActivityKey, number>>;
  users?: { id: number; email: string; role: string }[];
  /** null = the store has no sign-up record (created before audit logging, by seed, or by an admin). */
  creator?: StoreCreator | null;
}

export type CreatorKind = 'IP' | 'DEVICE' | 'FINGERPRINT';

export interface CreatorTarget {
  kind: CreatorKind;
  value: string;
  storeIds: number[];
}

export interface BlockResultItem extends CreatorTarget {
  status: 'BLOCKED' | 'ALREADY_BLOCKED' | 'FAILED';
  reason?: string;
}

class SkipStore extends Error {
  constructor(readonly item: PurgeResultItem) {
    super(item.reason);
  }
}

/** Distinct IPs / device ids / fingerprints across the given stores, each with the stores it created. */
export function collectCreatorTargets(items: PurgeResultItem[]): CreatorTarget[] {
  const map = new Map<string, CreatorTarget>();
  const add = (kind: CreatorKind, value: string | null | undefined, storeId: number) => {
    if (!value) return;
    const key = `${kind}:${value}`;
    const target = map.get(key) ?? { kind, value, storeIds: [] };
    if (!target.storeIds.includes(storeId)) target.storeIds.push(storeId);
    map.set(key, target);
  };
  for (const item of items) {
    if (!item.creator) continue;
    add('IP', item.creator.ipAddress, item.storeId);
    add('DEVICE', item.creator.deviceId, item.storeId);
    add('FINGERPRINT', item.creator.fingerprint, item.storeId);
  }
  return [...map.values()];
}

/**
 * Hard-deletes junk stores (and their user accounts) that never did any business, e.g. shops mass-created
 * by a sign-up script. Each store is checked and deleted in its own transaction under a row lock, so an
 * order arriving after the preview aborts that store only. Stores with real activity must be suspended.
 */
export class StorePurgeService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async purge(input: PurgeStoresInput, actor: PurgeActor) {
    if (!input.dryRun) {
      if (!input.reason || !input.actorPassword) throw new ValidationError('Cần lý do và mật khẩu xác nhận để xóa');
      const admin = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { passwordHash: true } });
      if (!admin || !(await comparePassword(input.actorPassword, admin.passwordHash))) {
        throw new ForbiddenError('Mật khẩu xác nhận không đúng');
      }
    }
    const reason = input.reason ?? '';

    const storeIds = [...new Set(input.storeIds)];
    const results: PurgeResultItem[] = [];
    for (const storeId of storeIds) {
      try {
        results.push(await this.purgeOne(storeId, input, actor));
      } catch (error) {
        if (error instanceof SkipStore) {
          results.push(error.item);
        } else {
          // Transaction rolled back: the store is untouched. Report it and carry on with the others.
          logger.error('store_purge_failed', { storeId, message: (error as Error)?.message });
          results.push({ storeId, status: 'FAILED', reason: 'Lỗi hệ thống khi xóa — cửa hàng chưa bị xóa, có thể thử lại' });
        }
      }
    }

    const dryRun = Boolean(input.dryRun);
    const deletedItems = results.filter((r) => r.status === 'DELETED');
    // Creators are only ever taken from stores deleted in this call, never from skipped/failed ones.
    const targets = collectCreatorTargets(dryRun ? results.filter((r) => r.status === 'DELETABLE') : deletedItems);
    const blocks = !dryRun && input.blockCreators && targets.length > 0 ? await this.blockCreators(targets, deletedItems, reason, actor) : null;

    return {
      dryRun,
      deleted: deletedItems.length,
      deletable: results.filter((r) => r.status === 'DELETABLE').length,
      skipped: results.filter((r) => r.status === 'SKIPPED' || r.status === 'NOT_FOUND').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
      results,
      /** Dry run: what "block creators" would block. Real run: what it targeted (when requested). */
      creatorTargets: dryRun || input.blockCreators ? targets : [],
      blocks,
    };
  }

  /** Reads the sign-up record of a store. Values are re-validated; anything malformed counts as missing. */
  private async findCreator(tx: Prisma.TransactionClient, storeId: number): Promise<StoreCreator | null> {
    const log = await tx.auditLog.findFirst({
      where: { action: STORE_REGISTERED_ACTION, storeId },
      orderBy: { createdAt: 'desc' },
      select: { ipAddress: true, afterJson: true, createdAt: true },
    });
    if (!log) return null;
    const after = (log.afterJson && typeof log.afterJson === 'object' ? log.afterJson : {}) as Record<string, unknown>;
    return {
      ipAddress: normalizeIp(log.ipAddress),
      deviceId: normalizeDeviceValue('DEVICE', after.deviceId),
      fingerprint: normalizeDeviceValue('FINGERPRINT', after.fingerprint),
      recordedAt: log.createdAt.toISOString(),
    };
  }

  private purgeOne(storeId: number, input: PurgeStoresInput, actor: PurgeActor) {
    return this.prisma.$transaction(async (tx) => {
      // Lock the store row: concurrent writes that reference the store wait until we commit or roll back.
      await tx.$queryRaw`SELECT id FROM stores WHERE id = ${storeId} FOR UPDATE`;
      const store = await tx.store.findUnique({
        where: { id: storeId },
        select: { id: true, name: true, code: true, isActive: true, createdAt: true },
      });
      if (!store) throw new SkipStore({ storeId, status: 'NOT_FOUND', reason: 'Không tìm thấy cửa hàng (có thể đã bị xóa)' });

      const users = await tx.user.findMany({ where: { storeId }, select: { id: true, email: true, role: true } });
      const creator = await this.findCreator(tx, storeId);
      const base = { storeId, name: store.name, code: store.code, users, creator };

      if (users.some((u) => u.role === 'ADMIN')) {
        throw new SkipStore({ ...base, status: 'SKIPPED', reason: 'Cửa hàng có tài khoản quản trị viên' });
      }

      // Re-checked at execution time inside the lock, so activity created after the preview is caught.
      const keys = Object.keys(ACTIVITY_CHECKS) as ActivityKey[];
      const counts = await Promise.all(keys.map((key) => ACTIVITY_CHECKS[key](tx, storeId)));
      const activity: Partial<Record<ActivityKey, number>> = {};
      keys.forEach((key, i) => {
        if (counts[i] > 0) activity[key] = counts[i];
      });
      if (Object.keys(activity).length > 0) {
        const summary = (Object.entries(activity) as [ActivityKey, number][]).map(([k, n]) => `${n} ${ACTIVITY_LABELS[k]}`).join(', ');
        throw new SkipStore({ ...base, status: 'SKIPPED', activity, reason: `Đã có ${summary} — chỉ có thể tạm ngưng` });
      }

      if (input.dryRun) return { ...base, status: 'DELETABLE' as const };

      const userIds = users.map((u) => u.id);
      const products = await tx.product.count({ where: { storeId } });
      // Users are SetNull on store delete, so remove them explicitly (their sessions/tokens cascade).
      if (userIds.length > 0) await tx.user.deleteMany({ where: { id: { in: userIds } } });
      // Every store-owned table is ON DELETE CASCADE; audit_logs.storeId becomes NULL and is kept.
      await tx.store.delete({ where: { id: storeId } });

      await AuditLogService.create(tx, {
        userId: actor.userId,
        action: STORE_PURGED_ACTION,
        entityType: 'STORE',
        entityId: storeId,
        beforeJson: {
          store: { id: store.id, name: store.name, code: store.code, isActive: store.isActive, createdAt: store.createdAt },
          users,
          products,
          creator,
        },
        afterJson: { deleted: true, reason: input.reason, blockCreators: Boolean(input.blockCreators) },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });

      return { ...base, status: 'DELETED' as const };
    });
  }

  /**
   * Blocks each distinct creator permanently through the existing IP / device blocklists (same validation,
   * self-lockout guards and audit log as the manual Block button). Each target is independent: one failure
   * never undoes the deletions or the other blocks, and is reported so the admin can retry.
   */
  private async blockCreators(targets: CreatorTarget[], deleted: PurgeResultItem[], reason: string, actor: PurgeActor) {
    const codes = (ids: number[]) =>
      ids
        .map((id) => deleted.find((d) => d.storeId === id)?.code)
        .filter(Boolean)
        .join(', ');
    const results: BlockResultItem[] = [];
    for (const target of targets) {
      const blockReason = `Tạo cửa hàng rác đã xóa (${codes(target.storeIds)}): ${reason}`.slice(0, 500);
      try {
        if (target.kind === 'IP') {
          await IpBlocklistService.add({ ip: target.value, reason: blockReason, expiresInHours: null }, actor, this.prisma);
        } else {
          await DeviceBlocklistService.add({ kind: target.kind, value: target.value, reason: blockReason, expiresInHours: null }, actor, this.prisma);
        }
        results.push({ ...target, status: 'BLOCKED' });
      } catch (error) {
        const message = error instanceof AppError ? error.message : 'Lỗi hệ thống khi chặn';
        const already = error instanceof ConflictError && /đã có trong danh sách chặn/.test(message);
        if (!(error instanceof AppError)) logger.error('store_purge_block_failed', { kind: target.kind, message: (error as Error)?.message });
        results.push({ ...target, status: already ? 'ALREADY_BLOCKED' : 'FAILED', reason: message });
      }
    }
    return {
      blocked: results.filter((r) => r.status === 'BLOCKED').length,
      alreadyBlocked: results.filter((r) => r.status === 'ALREADY_BLOCKED').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
      results,
    };
  }
}
