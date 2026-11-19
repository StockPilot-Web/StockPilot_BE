import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';

const ADMIN_PASSWORD = 'Adm1nPassword!';

jest.mock('../src/config/db', () => {
  const count = () => ({ count: jest.fn() });
  return {
    prisma: {
      user: { findUnique: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() },
      store: { findUnique: jest.fn(), delete: jest.fn() },
      order: count(),
      payment: count(),
      returnOrder: count(),
      stockMovement: count(),
      historicalSale: count(),
      stockTake: count(),
      importJob: count(),
      supportTicket: count(),
      storePaymentConfig: count(),
      product: count(),
      auditLog: { create: jest.fn() },
      $queryRaw: jest.fn(),
      $transaction: jest.fn(),
    },
  };
});

const db = prisma as any;

const admin = { id: 3, email: 'admin@stockpilot.test', fullName: 'Admin', role: 'ADMIN', storeId: null, isActive: true, store: null, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 4) };
const owner = { id: 1, email: 'owner@store-a.test', fullName: 'Owner', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true } };
const adminToken = generateAccessToken({ userId: 3, email: admin.email, role: 'ADMIN', storeId: null });
const ownerToken = generateAccessToken({ userId: 1, email: owner.email, role: 'SHOP_OWNER', storeId: 1 });

/** 10 = junk store (empty), 11 = real store (has orders + stock movements), 12 = has an admin user. */
const stores: Record<number, any> = {
  10: { id: 10, name: 'St SPA1795057493', code: 'st-spa1795057493', isActive: true, createdAt: new Date('2026-11-19T03:05:00Z') },
  11: { id: 11, name: 'Shop that', code: 'shop-that', isActive: true, createdAt: new Date('2026-01-01T00:00:00Z') },
  12: { id: 12, name: 'Weird', code: 'weird', isActive: true, createdAt: new Date('2026-01-01T00:00:00Z') },
};
const storeUsers: Record<number, any[]> = {
  10: [{ id: 50, email: 'i125a1795057493@mailinator.com', role: 'SHOP_OWNER' }],
  11: [{ id: 60, email: 'real@shop.vn', role: 'SHOP_OWNER' }],
  12: [{ id: 70, email: 'x@shop.vn', role: 'ADMIN' }],
};
const activity: Record<string, Record<number, number>> = { order: { 11: 4 }, stockMovement: { 11: 9 } };

beforeEach(() => {
  jest.clearAllMocks();
  db.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(where.id === 3 ? admin : where.id === 1 ? owner : null));
  db.user.findMany.mockImplementation(({ where }: any) => Promise.resolve(storeUsers[where.storeId] ?? []));
  db.store.findUnique.mockImplementation(({ where }: any) => Promise.resolve(stores[where.id] ?? null));
  for (const model of ['order', 'payment', 'returnOrder', 'stockMovement', 'historicalSale', 'stockTake', 'importJob', 'supportTicket', 'storePaymentConfig', 'product']) {
    db[model].count.mockImplementation(({ where }: any) => Promise.resolve(activity[model]?.[where.storeId] ?? 0));
  }
  db.user.deleteMany.mockResolvedValue({ count: 1 });
  db.store.delete.mockResolvedValue({});
  db.auditLog.create.mockResolvedValue({ id: 1n });
  db.$queryRaw.mockResolvedValue([]);
  db.$transaction.mockImplementation((callback: any) => callback(prisma));
});

describe('POST /admin/ops/stores/purge', () => {
  const app = createApp();
  const purge = (body: any, token = adminToken) =>
    request(app).post('/api/v1/admin/ops/stores/purge').set('Authorization', `Bearer ${token}`).send(body);
  const body = (extra: any = {}) => ({ storeIds: [10, 11, 12, 99], reason: 'Shop rác tạo bằng script', actorPassword: ADMIN_PASSWORD, ...extra });

  it('is ADMIN only', async () => {
    expect((await request(app).post('/api/v1/admin/ops/stores/purge').send(body())).status).toBe(401);
    expect((await purge(body(), ownerToken)).status).toBe(403);
    expect(db.store.delete).not.toHaveBeenCalled();
  });

  it('requires the admin password', async () => {
    const res = await purge(body({ actorPassword: 'wrong' }));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('Mật khẩu xác nhận không đúng');
    expect(db.store.delete).not.toHaveBeenCalled();
  });

  it('validates input', async () => {
    expect((await purge(body({ storeIds: [] }))).status).toBe(400);
    expect((await purge(body({ storeIds: Array.from({ length: 101 }, (_, i) => i + 1) }))).status).toBe(400);
    expect((await purge(body({ reason: 'x' }))).status).toBe(400);
  });

  it('dry run reports what would be deleted without deleting', async () => {
    const res = await purge(body({ dryRun: true }));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dryRun: true, deleted: 0, deletable: 1, skipped: 3 });
    expect(db.store.delete).not.toHaveBeenCalled();
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('deletes only empty stores (and their users), skips real ones, and audits each deletion', async () => {
    const res = await purge(body());
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.results.map((r: any) => [r.storeId, r]));

    expect(byId[10]).toMatchObject({ status: 'DELETED', code: 'st-spa1795057493' });
    expect(byId[11]).toMatchObject({ status: 'SKIPPED', activity: { orders: 4, stockMovements: 9 } });
    expect(byId[11].reason).toContain('chỉ có thể tạm ngưng');
    expect(byId[12]).toMatchObject({ status: 'SKIPPED', reason: 'Cửa hàng có tài khoản quản trị viên' });
    expect(byId[99]).toMatchObject({ status: 'NOT_FOUND' });
    expect(res.body.data).toMatchObject({ deleted: 1, skipped: 3 });

    expect(db.store.delete).toHaveBeenCalledTimes(1);
    expect(db.store.delete).toHaveBeenCalledWith({ where: { id: 10 } });
    expect(db.user.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [50] } } });
    expect(db.$queryRaw).toHaveBeenCalled(); // row lock taken before checking
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'STORE_PURGED',
          entityType: 'STORE',
          entityId: '10',
          userId: 3,
          storeId: null,
          afterJson: { deleted: true, reason: 'Shop rác tạo bằng script' },
        }),
      })
    );
  });

  it('a store that gets activity during the check is not deleted', async () => {
    db.payment.count.mockImplementation(({ where }: any) => Promise.resolve(where.storeId === 10 ? 1 : 0));
    const res = await purge(body({ storeIds: [10] }));
    expect(res.body.data.results[0]).toMatchObject({ status: 'SKIPPED', activity: { payments: 1 } });
    expect(db.store.delete).not.toHaveBeenCalled();
  });

  it('de-duplicates store ids', async () => {
    await purge(body({ storeIds: [10, 10, 10] }));
    expect(db.store.delete).toHaveBeenCalledTimes(1);
  });
});
