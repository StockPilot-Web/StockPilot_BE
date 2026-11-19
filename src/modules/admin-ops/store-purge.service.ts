import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ForbiddenError } from '../../common/errors/app-error';
import { AuditLogService } from '../../common/services/audit-log.service';
import { comparePassword } from '../../common/utils/password';
import type { RequestMeta } from './admin-ops.service';

export const STORE_PURGED_ACTION = 'STORE_PURGED';

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
  reason: string;
  actorPassword: string;
  /** true = only report what would be deleted. */
  dryRun?: boolean;
}

export interface PurgeResultItem {
  storeId: number;
  name?: string;
  code?: string;
  status: 'DELETED' | 'DELETABLE' | 'SKIPPED' | 'NOT_FOUND';
  reason?: string;
  activity?: Partial<Record<ActivityKey, number>>;
  users?: { id: number; email: string; role: string }[];
}

class SkipStore extends Error {
  constructor(readonly item: PurgeResultItem) {
    super(item.reason);
  }
}

/**
 * Hard-deletes junk stores (and their user accounts) that never did any business, e.g. shops mass-created
 * by a sign-up script. Each store is checked and deleted in its own transaction under a row lock, so an
 * order arriving mid-way aborts that store only. Stores with real activity must be suspended instead.
 */
export class StorePurgeService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async purge(input: PurgeStoresInput, actorUserId: number, meta: RequestMeta = {}) {
    const actor = await this.prisma.user.findUnique({ where: { id: actorUserId }, select: { passwordHash: true } });
    if (!actor || !(await comparePassword(input.actorPassword, actor.passwordHash))) {
      throw new ForbiddenError('Mật khẩu xác nhận không đúng');
    }

    const storeIds = [...new Set(input.storeIds)];
    const results: PurgeResultItem[] = [];
    for (const storeId of storeIds) {
      try {
        results.push(await this.purgeOne(storeId, input, actorUserId, meta));
      } catch (error) {
        if (error instanceof SkipStore) results.push(error.item);
        else throw error;
      }
    }

    return {
      dryRun: Boolean(input.dryRun),
      deleted: results.filter((r) => r.status === 'DELETED').length,
      deletable: results.filter((r) => r.status === 'DELETABLE').length,
      skipped: results.filter((r) => r.status === 'SKIPPED' || r.status === 'NOT_FOUND').length,
      results,
    };
  }

  private purgeOne(storeId: number, input: PurgeStoresInput, actorUserId: number, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      // Lock the store row: concurrent writes that reference the store wait until we commit or roll back.
      await tx.$queryRaw`SELECT id FROM stores WHERE id = ${storeId} FOR UPDATE`;
      const store = await tx.store.findUnique({
        where: { id: storeId },
        select: { id: true, name: true, code: true, isActive: true, createdAt: true },
      });
      if (!store) throw new SkipStore({ storeId, status: 'NOT_FOUND', reason: 'Không tìm thấy cửa hàng' });

      const users = await tx.user.findMany({ where: { storeId }, select: { id: true, email: true, role: true } });
      const base = { storeId, name: store.name, code: store.code, users };

      if (users.some((u) => u.role === 'ADMIN')) {
        throw new SkipStore({ ...base, status: 'SKIPPED', reason: 'Cửa hàng có tài khoản quản trị viên' });
      }

      const keys = Object.keys(ACTIVITY_CHECKS) as ActivityKey[];
      const counts = await Promise.all(keys.map((key) => ACTIVITY_CHECKS[key](tx, storeId)));
      const activity: Partial<Record<ActivityKey, number>> = {};
      keys.forEach((key, i) => {
        if (counts[i] > 0) activity[key] = counts[i];
      });
      if (Object.keys(activity).length > 0) {
        const summary = (Object.entries(activity) as [ActivityKey, number][]).map(([k, n]) => `${n} ${ACTIVITY_LABELS[k]}`).join(', ');
        throw new SkipStore({ ...base, status: 'SKIPPED', activity, reason: `Đã có dữ liệu thật (${summary}) — chỉ có thể tạm ngưng` });
      }

      if (input.dryRun) return { ...base, status: 'DELETABLE' as const };

      const userIds = users.map((u) => u.id);
      const products = await tx.product.count({ where: { storeId } });
      // Users are SetNull on store delete, so remove them explicitly (their sessions/tokens cascade).
      if (userIds.length > 0) await tx.user.deleteMany({ where: { id: { in: userIds } } });
      // Every store-owned table is ON DELETE CASCADE; audit_logs.storeId becomes NULL and is kept.
      await tx.store.delete({ where: { id: storeId } });

      await AuditLogService.create(tx, {
        userId: actorUserId,
        action: STORE_PURGED_ACTION,
        entityType: 'STORE',
        entityId: storeId,
        beforeJson: {
          store: { id: store.id, name: store.name, code: store.code, isActive: store.isActive, createdAt: store.createdAt },
          users,
          products,
        },
        afterJson: { deleted: true, reason: input.reason },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return { ...base, status: 'DELETED' as const };
    });
  }
}
