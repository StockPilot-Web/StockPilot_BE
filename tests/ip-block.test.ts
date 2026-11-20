import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';
import { isLoopback, normalizeIp, parseIpOrCidr, rangeContains } from '../src/common/utils/ip-address';
import { IpActivityService } from '../src/common/services/ip-activity.service';
import { IP_BLOCKLIST_SETTING_KEY, IpBlocklistService } from '../src/common/services/ip-blocklist.service';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: { findUnique: jest.fn(), create: jest.fn() },
    store: { findUnique: jest.fn(), create: jest.fn() },
    auditLog: { create: jest.fn(), groupBy: jest.fn(), findMany: jest.fn() },
    systemSetting: { findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

const db = prisma as any;

const users: Record<number, any> = {
  1: { id: 1, email: 'owner@store-a.test', fullName: 'Owner A', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true } },
  3: { id: 3, email: 'admin@stockpilot.test', fullName: 'Admin', role: 'ADMIN', storeId: null, isActive: true, store: null },
};
const adminToken = generateAccessToken({ userId: 3, email: 'admin@stockpilot.test', role: 'ADMIN', storeId: null });
const ownerToken = generateAccessToken({ userId: 1, email: 'owner@store-a.test', role: 'SHOP_OWNER', storeId: 1 });

/** In-memory system_settings row with an updatedAt the optimistic-concurrency check relies on. */
let settings: Map<string, { valueJson: any; updatedAt: Date }>;

function tick(date: Date) {
  return new Date(date.getTime() + 1);
}

beforeEach(() => {
  jest.clearAllMocks();
  IpBlocklistService.invalidate();
  IpActivityService.reset();
  delete process.env.BLOCKED_IPS;
  settings = new Map();

  db.user.findUnique.mockImplementation(({ where }: any) => {
    if (where.id !== undefined) return Promise.resolve(users[where.id] ?? null);
    return Promise.resolve(Object.values(users).find((u) => u.email === where.email) ?? null);
  });
  db.store.findUnique.mockResolvedValue(null);
  db.systemSetting.findUnique.mockImplementation(({ where }: any) => {
    const row = settings.get(where.key);
    return Promise.resolve(row ? { key: where.key, ...row } : null);
  });
  db.systemSetting.create.mockImplementation(({ data }: any) => {
    if (settings.has(data.key)) {
      return Promise.reject(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }));
    }
    settings.set(data.key, { valueJson: data.valueJson, updatedAt: new Date() });
    return Promise.resolve({});
  });
  db.systemSetting.updateMany.mockImplementation(({ where, data }: any) => {
    const row = settings.get(where.key);
    if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return Promise.resolve({ count: 0 });
    settings.set(where.key, { valueJson: data.valueJson, updatedAt: tick(row.updatedAt) });
    return Promise.resolve({ count: 1 });
  });
  db.auditLog.create.mockResolvedValue({ id: 1n });
  db.auditLog.groupBy.mockResolvedValue([]);
  db.auditLog.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation((callback: any) => callback(prisma));
});

function seedBlocklist(entries: any[]) {
  settings.set(IP_BLOCKLIST_SETTING_KEY, { valueJson: { entries }, updatedAt: new Date('2026-11-19T00:00:00Z') });
}

const entry = (cidr: string, extra: Partial<Record<string, any>> = {}) => ({
  id: extra.id ?? '11111111-1111-4111-8111-111111111111',
  cidr,
  reason: 'spam đăng ký',
  createdAt: '2026-11-19T00:00:00.000Z',
  createdById: 3,
  expiresAt: null,
  ...extra,
});

/** App with the blocklist on and `trust proxy` = 1, so X-Forwarded-For sets the client IP like Nginx does. */
function appWithBlocklist() {
  const app = createApp({ ipBlock: true });
  app.set('trust proxy', 1);
  return app;
}

describe('ip-address utils', () => {
  it('parses single IPs and canonicalises CIDR ranges', () => {
    expect(parseIpOrCidr('203.0.113.7')).toMatchObject({ cidr: '203.0.113.7', prefix: 32, family: 'ipv4' });
    expect(parseIpOrCidr('203.0.113.77/24')).toMatchObject({ cidr: '203.0.113.0/24', address: '203.0.113.0' });
    expect(parseIpOrCidr('10.20.30.40/16').cidr).toBe('10.20.0.0/16');
    expect(parseIpOrCidr('2001:DB8:abcd:1234::9/48').cidr).toBe('2001:db8:abcd::/48');
    expect(parseIpOrCidr('::ffff:198.51.100.4').cidr).toBe('198.51.100.4');
  });

  it('rejects invalid input and ranges that are too wide', () => {
    expect(() => parseIpOrCidr('not-an-ip')).toThrow('không hợp lệ');
    expect(() => parseIpOrCidr('300.1.1.1')).toThrow('không hợp lệ');
    expect(() => parseIpOrCidr('1.2.3.4/33')).toThrow('prefix');
    expect(() => parseIpOrCidr('1.2.3.4/abc')).toThrow('prefix');
    expect(() => parseIpOrCidr('1.2.3.4/24/1')).toThrow('không hợp lệ');
    expect(() => parseIpOrCidr('10.0.0.0/8')).toThrow('quá rộng');
    expect(() => parseIpOrCidr('2001:db8::/16')).toThrow('quá rộng');
  });

  it('matches IPs against ranges, including IPv4-mapped IPv6', () => {
    const range = parseIpOrCidr('203.0.113.0/24');
    expect(rangeContains(range, '203.0.113.250')).toBe(true);
    expect(rangeContains(range, '::ffff:203.0.113.9')).toBe(true);
    expect(rangeContains(range, '203.0.114.1')).toBe(false);
    expect(rangeContains(range, 'garbage')).toBe(false);
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('8.8.8.8')).toBe(false);
  });
});

describe('IpActivityService', () => {
  it('counts per-IP requests, errors, sign-ups and keeps only the window', () => {
    const now = Date.parse('2026-11-19T10:00:00Z');
    IpActivityService.record({ ip: '::ffff:198.51.100.4', method: 'POST', path: '/api/v1/auth/register?x=1', statusCode: 201, now });
    IpActivityService.record({ ip: '198.51.100.4', method: 'POST', path: '/api/v1/auth/send-register-otp', statusCode: 429, now });
    IpActivityService.record({ ip: '198.51.100.4', method: 'GET', path: '/api/v1/products', statusCode: 403, blocked: true, now });
    IpActivityService.record({ ip: '192.0.2.1', method: 'GET', path: '/api/v1/health', statusCode: 200, now: now - 90 * 60_000 });
    IpActivityService.record({ ip: 'not-an-ip', method: 'GET', path: '/', statusCode: 200, now });

    const result = IpActivityService.top({ minutes: 60, now });
    expect(result.top).toHaveLength(1);
    expect(result.top[0]).toMatchObject({
      ip: '198.51.100.4',
      requests: 3,
      clientErrors: 2,
      rateLimited: 1,
      blocked: 1,
      authRequests: 2,
      signupRequests: 2,
      lastPath: '/api/v1/products',
    });
    expect(result.trackedIps).toBe(2);
  });
});

describe('IP block middleware', () => {
  it('rejects a blocked IP with 403 IP_BLOCKED and lets other IPs through', async () => {
    seedBlocklist([entry('203.0.113.0/24')]);
    const app = appWithBlocklist();

    const blocked = await request(app).get('/api/v1/health').set('X-Forwarded-For', '203.0.113.50');
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ success: false, error: { code: 'IP_BLOCKED' } });
    expect(blocked.body.error.requestId).toBeTruthy();

    const allowed = await request(app).get('/api/v1/health').set('X-Forwarded-For', '198.51.100.4');
    expect(allowed.status).toBe(200);

    // Blocked hits are visible to the admin activity view.
    expect(IpActivityService.top().top.find((row) => row.ip === '203.0.113.50')).toMatchObject({ blocked: 1 });
  });

  it('ignores expired entries', async () => {
    seedBlocklist([entry('203.0.113.50', { expiresAt: '2020-01-01T00:00:00.000Z' })]);
    const res = await request(appWithBlocklist()).get('/api/v1/health').set('X-Forwarded-For', '203.0.113.50');
    expect(res.status).toBe(200);
  });

  it('honours the BLOCKED_IPS env list without touching the database', async () => {
    process.env.BLOCKED_IPS = '192.0.2.0/24, bogus';
    IpBlocklistService.invalidate();
    const res = await request(appWithBlocklist()).get('/api/v1/health').set('X-Forwarded-For', '192.0.2.9');
    expect(res.status).toBe(403);
    expect(db.systemSetting.findUnique).not.toHaveBeenCalled();
  });

  it('fails open when the blocklist cannot be read', async () => {
    db.systemSetting.findUnique.mockRejectedValue(new Error('db down'));
    const res = await request(appWithBlocklist()).get('/api/v1/health').set('X-Forwarded-For', '203.0.113.50');
    expect(res.status).toBe(200);
  });

  it('caches the list instead of reading it on every request', async () => {
    seedBlocklist([]);
    const app = appWithBlocklist();
    await request(app).get('/api/v1/health').set('X-Forwarded-For', '198.51.100.4');
    await request(app).get('/api/v1/health').set('X-Forwarded-For', '198.51.100.5');
    expect(db.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('is off by default in automated tests (createApp without options)', async () => {
    seedBlocklist([entry('203.0.113.50')]);
    const app = createApp();
    app.set('trust proxy', 1);
    const res = await request(app).get('/api/v1/health').set('X-Forwarded-For', '203.0.113.50');
    expect(res.status).toBe(200);
  });
});

describe('Admin IP block API', () => {
  const app = appWithBlocklist();
  const ADMIN_IP = '198.51.100.10';
  const admin = (req: request.Test) => req.set('Authorization', `Bearer ${adminToken}`).set('X-Forwarded-For', ADMIN_IP);

  it('requires an ADMIN', async () => {
    expect((await request(app).get('/api/v1/admin/ops/security/ip-blocks')).status).toBe(401);
    const res = await request(app).get('/api/v1/admin/ops/security/ip-blocks').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
    const post = await request(app)
      .post('/api/v1/admin/ops/security/ip-blocks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ip: '203.0.113.7', reason: 'spam' });
    expect(post.status).toBe(403);
    expect(settings.size).toBe(0);
  });

  it('blocks an IP, takes effect immediately, audits it, then unblocks', async () => {
    const created = await admin(request(app).post('/api/v1/admin/ops/security/ip-blocks')).send({
      ip: '203.0.113.77/24',
      reason: 'Tạo hàng loạt cửa hàng rác',
      expiresInHours: 24,
    });
    expect(created.status).toBe(200);
    expect(created.body.success).toBe(true);
    expect(created.body.data).toMatchObject({ cidr: '203.0.113.0/24', createdById: 3 });
    expect(created.body.data.expiresAt).toBeTruthy();
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'IP_BLOCKED', entityType: 'IP_BLOCKLIST', entityId: '203.0.113.0/24', userId: 3, ipAddress: ADMIN_IP }),
      })
    );

    const hit = await request(app).get('/api/v1/health').set('X-Forwarded-For', '203.0.113.5');
    expect(hit.status).toBe(403);

    const list = await admin(request(app).get('/api/v1/admin/ops/security/ip-blocks'));
    expect(list.status).toBe(200);
    expect(list.body.data.activeCount).toBe(1);
    const id = list.body.data.entries[0].id;

    const removed = await admin(request(app).delete(`/api/v1/admin/ops/security/ip-blocks/${id}`)).send({ reason: 'Đã xử lý xong' });
    expect(removed.status).toBe(200);
    expect(db.auditLog.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'IP_UNBLOCKED', entityId: '203.0.113.0/24' }) })
    );
    expect((await request(app).get('/api/v1/health').set('X-Forwarded-For', '203.0.113.5')).status).toBe(200);
  });

  it('refuses to block the admin’s own IP, loopback/the proxy hop, or too wide a range', async () => {
    const own = await admin(request(app).post('/api/v1/admin/ops/security/ip-blocks')).send({ ip: '198.51.100.0/24', reason: 'thử nghiệm' });
    expect(own.status).toBe(400);
    expect(own.body.error.message).toContain('chính địa chỉ IP bạn đang dùng');

    const loop = await admin(request(app).post('/api/v1/admin/ops/security/ip-blocks')).send({ ip: '127.0.0.1', reason: 'thử nghiệm' });
    expect(loop.status).toBe(400);

    const wide = await admin(request(app).post('/api/v1/admin/ops/security/ip-blocks')).send({ ip: '10.0.0.0/8', reason: 'thử nghiệm' });
    expect(wide.status).toBe(400);
    expect(wide.body.error.message).toContain('quá rộng');

    expect(settings.size).toBe(0);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects duplicates and unknown ids', async () => {
    seedBlocklist([entry('203.0.113.7')]);
    const dup = await admin(request(app).post('/api/v1/admin/ops/security/ip-blocks')).send({ ip: '203.0.113.7', reason: 'trùng lặp' });
    expect(dup.status).toBe(409);

    const missing = await admin(request(app).delete('/api/v1/admin/ops/security/ip-blocks/22222222-2222-4222-8222-222222222222')).send({
      reason: 'không tồn tại',
    });
    expect(missing.status).toBe(404);

    const badId = await admin(request(app).delete('/api/v1/admin/ops/security/ip-blocks/abc')).send({ reason: 'sai mã' });
    expect(badId.status).toBe(400);
  });

  it('detects a concurrent change instead of overwriting it', async () => {
    seedBlocklist([entry('203.0.113.7')]);
    // Another admin writes between our read and our update.
    db.systemSetting.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await admin(request(app).post('/api/v1/admin/ops/security/ip-blocks')).send({ ip: '203.0.113.8', reason: 'đồng thời' });
    expect(res.status).toBe(409);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('reports live and audited activity per IP with the blocked flag', async () => {
    seedBlocklist([entry('203.0.113.0/24')]);
    await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', '203.0.113.9').send({});
    db.auditLog.groupBy.mockResolvedValue([
      { ipAddress: '203.0.113.9', action: 'STORE_REGISTERED', _count: { _all: 12 }, _max: { createdAt: new Date('2026-11-19T09:00:00Z') } },
      { ipAddress: '203.0.113.9', action: 'LOGIN_FAILED', _count: { _all: 3 }, _max: { createdAt: new Date('2026-11-19T09:30:00Z') } },
      { ipAddress: '192.0.2.44', action: 'LOGIN_FAILED', _count: { _all: 2 }, _max: { createdAt: new Date('2026-11-19T08:00:00Z') } },
    ]);
    db.auditLog.findMany.mockResolvedValue([
      { createdAt: new Date(), ipAddress: '203.0.113.9', userAgent: 'curl/8', storeId: 9, store: { id: 9, name: 'rác', code: 'rac1', isActive: true }, user: { id: 9, email: 'x@y.z' } },
    ]);

    const res = await admin(request(app).get('/api/v1/admin/ops/security/ip-activity?hours=24&limit=10'));
    expect(res.status).toBe(200);
    const { live, audit } = res.body.data;
    expect(live.top.find((row: any) => row.ip === '203.0.113.9')).toMatchObject({ isBlocked: true, requests: 1 });
    expect(audit.byIp[0]).toMatchObject({ ipAddress: '203.0.113.9', signups: 12, loginFailures: 3, total: 15, isBlocked: true });
    expect(audit.byIp[1]).toMatchObject({ ipAddress: '192.0.2.44', isBlocked: false });
    expect(audit.recentSignups[0]).toMatchObject({ ipAddress: '203.0.113.9', isBlocked: true, store: { code: 'rac1' } });
    expect(db.auditLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ action: { in: ['STORE_REGISTERED', 'LOGIN_FAILED', 'LOGIN_BLOCKED'] } }) })
    );
  });
});

describe('Sign-up guards', () => {
  const validRegister = {
    fullName: 'Kẻ Phá',
    email: 'spam@example.test',
    password: 'Password123!',
    storeName: 'Shop rác',
    storeCode: 'shop-rac',
  };

  it('rate limits /auth/register and /auth/send-register-otp per IP with separate counters', async () => {
    const app = createApp({ signupRateLimit: { windowMs: 60_000, max: 2 } });
    app.set('trust proxy', 1);
    const register = () => request(app).post('/api/v1/auth/register').set('X-Forwarded-For', '203.0.113.20').send({});

    expect((await register()).status).toBe(400);
    expect((await register()).status).toBe(400);
    const limited = await register();
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });

    // Another IP is unaffected, and the OTP endpoint has its own counter.
    expect((await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', '203.0.113.21').send({})).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/send-register-otp').set('X-Forwarded-For', '203.0.113.20').send({})).status).toBe(400);
  });

  it('blocks new accounts when the admin turns signup.enabled off', async () => {
    settings.set('signup.enabled', { valueJson: false, updatedAt: new Date() });
    const app = createApp();

    const otp = await request(app).post('/api/v1/auth/send-register-otp').send({ email: validRegister.email });
    expect(otp.status).toBe(403);
    expect(otp.body.error.code).toBe('FORBIDDEN');

    const reg = await request(app).post('/api/v1/auth/register').send(validRegister);
    expect(reg.status).toBe(403);
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.store.create).not.toHaveBeenCalled();
  });
});

describe('Disposable e-mail sign-up block', () => {
  const { isBlockedSignupEmail } = jest.requireActual('../src/common/utils/signup-email-policy');

  afterEach(() => {
    delete process.env.SIGNUP_BLOCKED_EMAIL_DOMAINS;
  });

  it('matches disposable domains, their subdomains and env extras', () => {
    expect(isBlockedSignupEmail('i125c1795057055@mailinator.com')).toBe(true);
    expect(isBlockedSignupEmail('X@Sub.Mailinator.com ')).toBe(true);
    expect(isBlockedSignupEmail('owner@gmail.com')).toBe(false);
    expect(isBlockedSignupEmail('a@notmailinator.com')).toBe(false);
    process.env.SIGNUP_BLOCKED_EMAIL_DOMAINS = '@spam.vn, junk.io';
    expect(isBlockedSignupEmail('a@spam.vn')).toBe(true);
    expect(isBlockedSignupEmail('a@x.junk.io')).toBe(true);
  });

  it('rejects OTP and register requests from @mailinator.com before creating anything', async () => {
    const app = createApp();
    const otp = await request(app).post('/api/v1/auth/send-register-otp').send({ email: 'i129c@mailinator.com' });
    expect(otp.status).toBe(400);
    expect(otp.body.error.message).toContain('email tạm thời');

    const reg = await request(app).post('/api/v1/auth/register').send({
      fullName: 'I129 T',
      email: 'i125a1795057055@mailinator.com',
      password: 'Password123!',
      storeName: 'I129 T Store',
      storeCode: 'i129-t',
    });
    expect(reg.status).toBe(400);
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.store.create).not.toHaveBeenCalled();
  });
});
