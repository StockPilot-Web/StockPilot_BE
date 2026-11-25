import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';
import { IpBlocklistService } from '../src/common/services/ip-blocklist.service';
import { DeviceBlocklistService } from '../src/common/services/device-blocklist.service';

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
      auditLog: { create: jest.fn(), findFirst: jest.fn() },
      systemSetting: { findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
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

const DEV_A = '2b1c7f0e-3d4a-4b5c-9d8e-7f6a5b4c3d2e';
const FP_A = 'a'.repeat(64);

/**
 * 10, 13 = junk stores (empty) created from the same IP/device; 11 = real store (orders + stock movements);
 * 12 = has an admin user; 14 = empty but no sign-up record.
 */
const stores: Record<number, any> = {
  10: { id: 10, name: 'St SPA1795057493', code: 'st-spa1795057493', isActive: true, createdAt: new Date('2026-11-19T03:05:00Z') },
  11: { id: 11, name: 'Shop that', code: 'shop-that', isActive: true, createdAt: new Date('2026-01-01T00:00:00Z') },
  12: { id: 12, name: 'Weird', code: 'weird', isActive: true, createdAt: new Date('2026-01-01T00:00:00Z') },
  13: { id: 13, name: 'St SPB1795057493', code: 'st-spb1795057493', isActive: true, createdAt: new Date('2026-11-19T03:05:00Z') },
  14: { id: 14, name: 'Seeded', code: 'seeded', isActive: true, createdAt: new Date('2026-01-01T00:00:00Z') },
};
const storeUsers: Record<number, any[]> = {
  10: [{ id: 50, email: 'i125a1795057493@mailinator.com', role: 'SHOP_OWNER' }],
  11: [{ id: 60, email: 'real@shop.vn', role: 'SHOP_OWNER' }],
  12: [{ id: 70, email: 'x@shop.vn', role: 'ADMIN' }],
  13: [{ id: 51, email: 'i125b1795057493@mailinator.com', role: 'SHOP_OWNER' }],
  14: [],
};
const signupLogs: Record<number, any> = {
  10: { ipAddress: '::ffff:203.0.113.9', afterJson: { storeId: 10, deviceId: DEV_A, fingerprint: FP_A }, createdAt: new Date('2026-11-19T03:05:00Z') },
  13: { ipAddress: '203.0.113.9', afterJson: { storeId: 13, deviceId: DEV_A, fingerprint: 'not-a-fingerprint' }, createdAt: new Date('2026-11-19T03:05:01Z') },
  11: { ipAddress: '198.51.100.20', afterJson: { storeId: 11, deviceId: null, fingerprint: null }, createdAt: new Date('2026-01-01T00:00:00Z') },
};
let activity: Record<string, Record<number, number>>;
let settings: Map<string, { valueJson: any; updatedAt: Date }>;

beforeEach(() => {
  jest.clearAllMocks();
  IpBlocklistService.invalidate();
  DeviceBlocklistService.invalidate();
  activity = { order: { 11: 4 }, stockMovement: { 11: 9 } };
  settings = new Map();
  db.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(where.id === 3 ? admin : where.id === 1 ? owner : null));
  db.user.findMany.mockImplementation(({ where }: any) => Promise.resolve(storeUsers[where.storeId] ?? []));
  db.store.findUnique.mockImplementation(({ where }: any) => Promise.resolve(stores[where.id] ?? null));
  for (const model of ['order', 'payment', 'returnOrder', 'stockMovement', 'historicalSale', 'stockTake', 'importJob', 'supportTicket', 'storePaymentConfig', 'product']) {
    db[model].count.mockImplementation(({ where }: any) => Promise.resolve(activity[model]?.[where.storeId] ?? 0));
  }
  db.auditLog.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(where.action === 'STORE_REGISTERED' ? signupLogs[where.storeId] ?? null : null)
  );
  db.user.deleteMany.mockResolvedValue({ count: 1 });
  db.store.delete.mockResolvedValue({});
  db.auditLog.create.mockResolvedValue({ id: 1n });
  db.systemSetting.findUnique.mockImplementation(({ where }: any) => {
    const row = settings.get(where.key);
    return Promise.resolve(row ? { key: where.key, ...row } : null);
  });
  db.systemSetting.create.mockImplementation(({ data }: any) => {
    settings.set(data.key, { valueJson: data.valueJson, updatedAt: new Date() });
    return Promise.resolve({});
  });
  db.systemSetting.updateMany.mockImplementation(({ where, data }: any) => {
    const row = settings.get(where.key);
    if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return Promise.resolve({ count: 0 });
    settings.set(where.key, { valueJson: data.valueJson, updatedAt: new Date(row.updatedAt.getTime() + 1) });
    return Promise.resolve({ count: 1 });
  });
  db.$queryRaw.mockResolvedValue([]);
  db.$transaction.mockImplementation((callback: any) => callback(prisma));
});

const blockedValues = (key: string) => (settings.get(key)?.valueJson?.entries ?? []).map((e: any) => e.cidr ?? `${e.kind}:${e.value}`);

describe('POST /admin/ops/stores/purge', () => {
  const app = createApp();
  app.set('trust proxy', 1);
  const purge = (body: any, token = adminToken) =>
    request(app).post('/api/v1/admin/ops/stores/purge').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '198.51.100.77').send(body);
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
    expect((await purge(body({ blockCreators: 'yes' }))).status).toBe(400);
    // A real deletion needs reason + password; the read-only preview does not.
    expect((await purge({ storeIds: [10] })).status).toBe(400);
    expect((await purge({ storeIds: [10], reason: 'Shop rác' })).status).toBe(400);
    const preview = await purge({ storeIds: [10], dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.data.results[0].status).toBe('DELETABLE');
    expect(db.store.delete).not.toHaveBeenCalled();
  });

  it('dry run reports deletable/skipped stores and the recorded creators, without deleting or blocking', async () => {
    const res = await purge(body({ storeIds: [10, 11, 12, 13, 14, 99], dryRun: true }));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dryRun: true, deleted: 0, deletable: 3, skipped: 3, failed: 0, blocks: null });
    const byId = Object.fromEntries(res.body.data.results.map((r: any) => [r.storeId, r]));
    expect(byId[10].creator).toMatchObject({ ipAddress: '203.0.113.9', deviceId: DEV_A, fingerprint: FP_A });
    expect(byId[13].creator).toMatchObject({ ipAddress: '203.0.113.9', deviceId: DEV_A, fingerprint: null }); // malformed value dropped
    expect(byId[14].creator).toBeNull();
    expect(byId[11]).toMatchObject({ status: 'SKIPPED', activity: { orders: 4, stockMovements: 9 } });
    // Distinct targets, only from deletable stores (store 11's IP is not included).
    const targets = res.body.data.creatorTargets.map((t: any) => `${t.kind}:${t.value}:${t.storeIds.join('+')}`).sort();
    expect(targets).toEqual(['DEVICE:' + DEV_A + ':10+13', 'FINGERPRINT:' + FP_A + ':10', 'IP:203.0.113.9:10+13'].sort());
    expect(db.store.delete).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(settings.size).toBe(0);
  });

  it('deletes only empty stores (and their users), skips real ones, and audits each deletion', async () => {
    const res = await purge(body());
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.results.map((r: any) => [r.storeId, r]));
    expect(byId[10]).toMatchObject({ status: 'DELETED', code: 'st-spa1795057493' });
    expect(byId[11]).toMatchObject({ status: 'SKIPPED' });
    expect(byId[11].reason).toBe('Đã có 4 đơn hàng, 9 biến động kho — chỉ có thể tạm ngưng');
    expect(byId[12]).toMatchObject({ status: 'SKIPPED', reason: 'Cửa hàng có tài khoản quản trị viên' });
    expect(byId[99]).toMatchObject({ status: 'NOT_FOUND' });
    expect(res.body.data).toMatchObject({ deleted: 1, skipped: 3, failed: 0, blocks: null, creatorTargets: [] });
    expect(db.store.delete).toHaveBeenCalledTimes(1);
    expect(db.user.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [50] } } });
    expect(db.$queryRaw).toHaveBeenCalled(); // row lock taken before checking
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'STORE_PURGED', entityType: 'STORE', entityId: '10', userId: 3, storeId: null }),
      })
    );
    expect(settings.size).toBe(0); // blockCreators defaults to false
  });

  it('re-checks at execution time: a store that got an order after the preview is not deleted nor blocked', async () => {
    const preview = await purge(body({ storeIds: [10], dryRun: true }));
    expect(preview.body.data.results[0].status).toBe('DELETABLE');
    activity.order[10] = 1; // an order arrives between preview and confirmation
    const res = await purge(body({ storeIds: [10], blockCreators: true }));
    expect(res.body.data.results[0]).toMatchObject({ status: 'SKIPPED', activity: { orders: 1 } });
    expect(res.body.data).toMatchObject({ deleted: 0, blocks: null, creatorTargets: [] });
    expect(db.store.delete).not.toHaveBeenCalled();
    expect(settings.size).toBe(0);
  });

  it('blocks the creators of deleted stores only, de-duplicated, through the existing blocklists', async () => {
    const res = await purge(body({ storeIds: [10, 11, 13, 14], blockCreators: true }));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deleted: 3, skipped: 1 });
    expect(res.body.data.blocks).toMatchObject({ blocked: 3, alreadyBlocked: 0, failed: 0 });
    expect(blockedValues('ops.security.ipBlocklist')).toEqual(['203.0.113.9']); // not store 11's 198.51.100.20
    expect(blockedValues('ops.security.deviceBlocklist').sort()).toEqual([`DEVICE:${DEV_A}`, `FINGERPRINT:${FP_A}`].sort());
    const actions = db.auditLog.create.mock.calls.map((c: any) => c[0].data.action);
    expect(actions.filter((a: string) => a === 'STORE_PURGED')).toHaveLength(3);
    expect(actions).toEqual(expect.arrayContaining(['IP_BLOCKED', 'DEVICE_BLOCKED']));
    expect((await request(app).get('/api/v1/health')).status).toBe(200); // ipBlock middleware off in tests; list checked via service
    expect(await IpBlocklistService.isBlocked('203.0.113.9')).toBe(true);
  });

  it('reports partial success: deletions stand when a block fails or the value is already blocked', async () => {
    settings.set('ops.security.ipBlocklist', {
      valueJson: { entries: [{ id: 'x', cidr: '203.0.113.9', reason: 'old', createdAt: '2026-11-19T00:00:00.000Z', createdById: 3, expiresAt: null }] },
      updatedAt: new Date('2026-11-19T00:00:00Z'),
    });
    let calls = 0;
    db.systemSetting.create.mockImplementation(({ data }: any) => {
      calls += 1;
      if (data.key === 'ops.security.deviceBlocklist' && calls === 1) return Promise.reject(new Error('db hiccup'));
      settings.set(data.key, { valueJson: data.valueJson, updatedAt: new Date() });
      return Promise.resolve({});
    });
    const res = await purge(body({ storeIds: [10], blockCreators: true }));
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(1);
    const byKind = Object.fromEntries(res.body.data.blocks.results.map((r: any) => [r.kind, r]));
    expect(byKind.IP).toMatchObject({ status: 'ALREADY_BLOCKED' });
    expect(byKind.DEVICE).toMatchObject({ status: 'FAILED', reason: 'Lỗi hệ thống khi chặn' });
    expect(byKind.FINGERPRINT).toMatchObject({ status: 'BLOCKED' });
    expect(res.body.data.blocks).toMatchObject({ blocked: 1, alreadyBlocked: 1, failed: 1 });
  });

  it('never blocks the admin’s own IP even if it created a store', async () => {
    signupLogs[14] = { ipAddress: '198.51.100.77', afterJson: {}, createdAt: new Date() };
    try {
      const res = await purge(body({ storeIds: [14], blockCreators: true }));
      expect(res.body.data.blocks.results[0]).toMatchObject({ kind: 'IP', status: 'FAILED' });
      expect(res.body.data.blocks.results[0].reason).toContain('chính địa chỉ IP bạn đang dùng');
      expect(res.body.data.deleted).toBe(1);
    } finally {
      delete signupLogs[14];
    }
  });

  it('reports a store whose deletion fails as FAILED and keeps going', async () => {
    db.store.delete.mockImplementation(({ where }: any) => (where.id === 10 ? Promise.reject(new Error('deadlock')) : Promise.resolve({})));
    const res = await purge(body({ storeIds: [10, 13], blockCreators: true }));
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.results.map((r: any) => [r.storeId, r]));
    expect(byId[10]).toMatchObject({ status: 'FAILED' });
    expect(byId[13]).toMatchObject({ status: 'DELETED' });
    expect(res.body.data).toMatchObject({ deleted: 1, failed: 1 });
    // Only store 13's creator is targeted: FP_A belongs to store 10 (failed) and must not be blocked.
    expect(res.body.data.creatorTargets.map((t: any) => t.kind).sort()).toEqual(['DEVICE', 'IP']);
    expect(blockedValues('ops.security.deviceBlocklist')).toEqual([`DEVICE:${DEV_A}`]);
  });

  it('de-duplicates store ids', async () => {
    await purge(body({ storeIds: [10, 10, 10] }));
    expect(db.store.delete).toHaveBeenCalledTimes(1);
  });
});
