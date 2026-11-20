import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';
import { normalizeDeviceValue, readDeviceIdentity } from '../src/common/utils/device-identity';
import { DEVICE_BLOCKLIST_SETTING_KEY, DeviceBlocklistService } from '../src/common/services/device-blocklist.service';
import { IpActivityService } from '../src/common/services/ip-activity.service';
import { IpBlocklistService } from '../src/common/services/ip-blocklist.service';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    auditLog: { create: jest.fn(), groupBy: jest.fn(), findMany: jest.fn() },
    systemSetting: { findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

const db = prisma as any;
const admin = { id: 3, email: 'admin@stockpilot.test', fullName: 'Admin', role: 'ADMIN', storeId: null, isActive: true, store: null };
const owner = { id: 1, email: 'owner@store-a.test', fullName: 'Owner', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true } };
const adminToken = generateAccessToken({ userId: 3, email: admin.email, role: 'ADMIN', storeId: null });
const ownerToken = generateAccessToken({ userId: 1, email: owner.email, role: 'SHOP_OWNER', storeId: 1 });

const BAD_DEVICE = '2b1c7f0e-3d4a-4b5c-9d8e-7f6a5b4c3d2e';
const BAD_FP = 'a'.repeat(64);
const ADMIN_DEVICE = '11111111-2222-4333-8444-555555555555';
const ADMIN_FP = 'b'.repeat(64);

let settings: Map<string, { valueJson: any; updatedAt: Date }>;

beforeEach(() => {
  jest.clearAllMocks();
  DeviceBlocklistService.invalidate();
  IpBlocklistService.invalidate();
  IpActivityService.reset();
  settings = new Map();
  db.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(where.id === 3 ? admin : where.id === 1 ? owner : null));
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
  db.auditLog.create.mockResolvedValue({ id: 1n });
  db.auditLog.groupBy.mockResolvedValue([]);
  db.auditLog.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation((callback: any) => callback(prisma));
});

function appWithBlocklist() {
  const app = createApp({ ipBlock: true });
  app.set('trust proxy', 1);
  return app;
}

describe('device identity headers', () => {
  it('normalises valid values and rejects junk', () => {
    expect(normalizeDeviceValue('DEVICE', ` ${BAD_DEVICE.toUpperCase()} `)).toBe(BAD_DEVICE);
    expect(normalizeDeviceValue('DEVICE', 'short')).toBeNull();
    expect(normalizeDeviceValue('DEVICE', "x'; DROP TABLE users;--xxxxxxxx")).toBeNull();
    expect(normalizeDeviceValue('FINGERPRINT', BAD_FP.toUpperCase())).toBe(BAD_FP);
    expect(normalizeDeviceValue('FINGERPRINT', 'z'.repeat(64))).toBeNull();
    expect(readDeviceIdentity({ headers: { 'x-device-id': BAD_DEVICE, 'x-device-fp': 'nope' } } as any)).toEqual({ deviceId: BAD_DEVICE, fingerprint: null });
  });
});

describe('device block middleware', () => {
  function seed(entries: any[]) {
    settings.set(DEVICE_BLOCKLIST_SETTING_KEY, { valueJson: { entries }, updatedAt: new Date('2026-11-19T00:00:00Z') });
  }
  const entry = (kind: string, value: string, extra: any = {}) => ({
    id: `${kind}-1`, kind, value, reason: 'spam', createdAt: '2026-11-19T00:00:00.000Z', createdById: 3, expiresAt: null, ...extra,
  });

  it('rejects a blocked device id or fingerprint with 403 DEVICE_BLOCKED', async () => {
    seed([entry('DEVICE', BAD_DEVICE), entry('FINGERPRINT', BAD_FP)]);
    const app = appWithBlocklist();
    const byId = await request(app).get('/api/v1/health').set('X-Device-Id', BAD_DEVICE);
    expect(byId.status).toBe(403);
    expect(byId.body.error.code).toBe('DEVICE_BLOCKED');
    const byFp = await request(app).get('/api/v1/health').set('X-Device-Id', ADMIN_DEVICE).set('X-Device-Fp', BAD_FP);
    expect(byFp.status).toBe(403);
    expect((await request(app).get('/api/v1/health').set('X-Device-Id', ADMIN_DEVICE).set('X-Device-Fp', ADMIN_FP)).status).toBe(200);
    expect((await request(app).get('/api/v1/health')).status).toBe(200);
  });

  it('ignores expired entries and fails open on read errors', async () => {
    seed([entry('DEVICE', BAD_DEVICE, { expiresAt: '2020-01-01T00:00:00.000Z' })]);
    expect((await request(appWithBlocklist()).get('/api/v1/health').set('X-Device-Id', BAD_DEVICE)).status).toBe(200);
    DeviceBlocklistService.invalidate();
    db.systemSetting.findUnique.mockRejectedValue(new Error('db down'));
    expect((await request(appWithBlocklist()).get('/api/v1/health').set('X-Device-Id', BAD_DEVICE)).status).toBe(200);
  });

  it('records device signals per IP for the activity view', async () => {
    await request(appWithBlocklist()).get('/api/v1/health').set('X-Forwarded-For', '203.0.113.9').set('X-Device-Id', BAD_DEVICE).set('X-Device-Fp', BAD_FP);
    expect(IpActivityService.top().top[0]).toMatchObject({ ip: '203.0.113.9', deviceIds: [BAD_DEVICE], fingerprints: [BAD_FP] });
  });
});

describe('Admin device block API', () => {
  const app = appWithBlocklist();
  const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${adminToken}`).set('X-Device-Id', ADMIN_DEVICE).set('X-Device-Fp', ADMIN_FP);

  it('is ADMIN only', async () => {
    expect((await request(app).get('/api/v1/admin/ops/security/device-blocks')).status).toBe(401);
    const res = await request(app)
      .post('/api/v1/admin/ops/security/device-blocks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ kind: 'DEVICE', value: BAD_DEVICE, reason: 'spam' });
    expect(res.status).toBe(403);
  });

  it('blocks permanently, takes effect at once, audits, lists and unblocks', async () => {
    const created = await asAdmin(request(app).post('/api/v1/admin/ops/security/device-blocks')).send({
      kind: 'FINGERPRINT',
      value: BAD_FP,
      reason: 'Máy tạo shop rác',
      expiresInHours: null,
    });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ kind: 'FINGERPRINT', value: BAD_FP, expiresAt: null, createdById: 3 });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'DEVICE_BLOCKED', entityType: 'DEVICE_BLOCKLIST' }) })
    );
    expect((await request(app).get('/api/v1/health').set('X-Device-Fp', BAD_FP)).status).toBe(403);

    const list = await asAdmin(request(app).get('/api/v1/admin/ops/security/device-blocks'));
    expect(list.body.data.activeCount).toBe(1);
    const id = list.body.data.entries[0].id;
    const removed = await asAdmin(request(app).delete(`/api/v1/admin/ops/security/device-blocks/${id}`)).send({ reason: 'Nhầm máy' });
    expect(removed.status).toBe(200);
    expect((await request(app).get('/api/v1/health').set('X-Device-Fp', BAD_FP)).status).toBe(200);
  });

  it('refuses the admin’s own device, invalid values and duplicates', async () => {
    const own = await asAdmin(request(app).post('/api/v1/admin/ops/security/device-blocks')).send({ kind: 'DEVICE', value: ADMIN_DEVICE, reason: 'thử' + 'x' });
    expect(own.status).toBe(400);
    expect(own.body.error.message).toContain('thiết bị bạn đang dùng');
    const bad = await asAdmin(request(app).post('/api/v1/admin/ops/security/device-blocks')).send({ kind: 'FINGERPRINT', value: 'g'.repeat(40), reason: 'thử nghiệm' });
    expect(bad.status).toBe(400);

    await asAdmin(request(app).post('/api/v1/admin/ops/security/device-blocks')).send({ kind: 'DEVICE', value: BAD_DEVICE, reason: 'lần đầu' });
    const dup = await asAdmin(request(app).post('/api/v1/admin/ops/security/device-blocks')).send({ kind: 'DEVICE', value: BAD_DEVICE, reason: 'lần hai' });
    expect(dup.status).toBe(409);
  });

  it('shows device signals and block state on recent sign-ups', async () => {
    settings.set(DEVICE_BLOCKLIST_SETTING_KEY, {
      valueJson: { entries: [{ id: 'x', kind: 'DEVICE', value: BAD_DEVICE, reason: 'spam', createdAt: '2026-11-19T00:00:00.000Z', createdById: 3, expiresAt: null }] },
      updatedAt: new Date(),
    });
    db.auditLog.findMany.mockResolvedValue([
      {
        createdAt: new Date(),
        ipAddress: '203.0.113.9',
        userAgent: 'curl/8',
        afterJson: { storeId: 9, deviceId: BAD_DEVICE, fingerprint: BAD_FP },
        storeId: 9,
        store: { id: 9, name: 'rác', code: 'rac', isActive: true },
        user: { id: 9, email: 'x@mailinator.com' },
      },
    ]);
    const res = await asAdmin(request(app).get('/api/v1/admin/ops/security/ip-activity'));
    expect(res.status).toBe(200);
    expect(res.body.data.audit.recentSignups[0]).toMatchObject({ deviceId: BAD_DEVICE, fingerprint: BAD_FP, deviceBlockedBy: 'DEVICE', isBlocked: false });
    expect(res.body.data.audit.recentSignups[0].afterJson).toBeUndefined();
  });
});
