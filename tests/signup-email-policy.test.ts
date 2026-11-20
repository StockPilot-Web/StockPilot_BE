import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';
import { domainMatches, emailDomainListSchema, normalizeEmailDomain } from '../src/common/utils/email-domain';
import { SignupEmailPolicy, SignupEmailPolicyService } from '../src/common/services/signup-email-policy.service';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: { findUnique: jest.fn(), create: jest.fn() },
    store: { findUnique: jest.fn(), create: jest.fn() },
    auditLog: { create: jest.fn() },
    systemSetting: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(),
  },
}));

const db = prisma as any;
const admin = { id: 3, email: 'admin@stockpilot.test', fullName: 'Admin', role: 'ADMIN', storeId: null, isActive: true, store: null };
const owner = { id: 1, email: 'owner@store-a.test', fullName: 'Owner', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true } };
const adminToken = generateAccessToken({ userId: 3, email: admin.email, role: 'ADMIN', storeId: null });
const ownerToken = generateAccessToken({ userId: 1, email: owner.email, role: 'SHOP_OWNER', storeId: 1 });

let settings: Map<string, any>;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SIGNUP_BLOCKED_EMAIL_DOMAINS;
  settings = new Map();
  db.user.findUnique.mockImplementation(({ where }: any) => {
    if (where.id === 3) return Promise.resolve(admin);
    if (where.id === 1) return Promise.resolve(owner);
    return Promise.resolve(null); // e-mail lookups: not registered yet
  });
  db.store.findUnique.mockResolvedValue(null);
  db.systemSetting.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(settings.has(where.key) ? { key: where.key, valueJson: settings.get(where.key), updatedAt: new Date() } : null)
  );
  db.systemSetting.findMany.mockResolvedValue([]);
  db.systemSetting.upsert.mockImplementation(({ where, create, update }: any) => {
    settings.set(where.key, settings.has(where.key) ? update.valueJson : create.valueJson);
    return Promise.resolve({});
  });
  db.auditLog.create.mockResolvedValue({ id: 1n });
  db.$transaction.mockImplementation((callback: any) => callback(prisma));
});

describe('e-mail domain helpers', () => {
  it('normalises domains and rejects garbage', () => {
    expect(normalizeEmailDomain('  @OOYNIB.com ')).toBe('ooynib.com');
    expect(normalizeEmailDomain('mail.Example.co.uk.')).toBe('mail.example.co.uk');
    expect(normalizeEmailDomain('xn--p1ai.xn--p1ai')).toBe('xn--p1ai.xn--p1ai');
    for (const bad of ['', 'localhost', 'a..b.com', '-bad.com', 'bad-.com', 'has space.com', 'x@y.com', 'http://evil.com', '1.2.3.4']) {
      expect(normalizeEmailDomain(bad)).toBeNull();
    }
  });

  it('matches on label boundaries: the domain and its subdomains only', () => {
    expect(domainMatches('ooynib.com', 'ooynib.com')).toBe(true);
    expect(domainMatches('a.b.ooynib.com', 'ooynib.com')).toBe(true);
    expect(domainMatches('notooynib.com', 'ooynib.com')).toBe(false);
    expect(domainMatches('ooynib.com.evil.net', 'ooynib.com')).toBe(false);
  });

  it('list schema normalises, de-duplicates and names the invalid entry', () => {
    const schema = emailDomainListSchema(3);
    expect(schema.parse(['Gmail.com', '@gmail.com', 'outlook.com'])).toEqual(['gmail.com', 'outlook.com']);
    const bad = schema.safeParse(['gmail.com', 'not a domain']);
    expect(bad.success).toBe(false);
    expect(!bad.success && bad.error.issues[0].message).toContain('not a domain');
    expect(schema.safeParse(['a.com', 'b.com', 'c.com', 'd.com']).success).toBe(false);
  });
});

describe('SignupEmailPolicyService.evaluate', () => {
  const policy = (extra: Partial<SignupEmailPolicy> = {}): SignupEmailPolicy => ({
    builtInBlocked: ['mailinator.com'],
    envBlocked: [],
    adminBlocked: [],
    allowlist: { enabled: false, domains: [] },
    ...extra,
  });

  it('blocks built-in, env and admin lists; admin blocks include subdomains', () => {
    expect(SignupEmailPolicyService.evaluate('a@mailinator.com', policy())).toMatchObject({ allowed: false, reason: 'BLOCKED', source: 'BUILT_IN' });
    expect(SignupEmailPolicyService.evaluate('a@x.ooynib.com', policy({ adminBlocked: ['ooynib.com'] }))).toMatchObject({ allowed: false, source: 'ADMIN', rule: 'ooynib.com' });
    expect(SignupEmailPolicyService.evaluate('a@euploading.com', policy({ envBlocked: ['euploading.com'] }))).toMatchObject({ allowed: false, source: 'ENV' });
    expect(SignupEmailPolicyService.evaluate('a@gmail.com', policy({ adminBlocked: ['ooynib.com'] }))).toEqual({ allowed: true, domain: 'gmail.com' });
  });

  it('allow-list mode accepts only listed domains, and the block list always wins', () => {
    const p = policy({ adminBlocked: ['bad.gmail.com'], allowlist: { enabled: true, domains: ['gmail.com', 'outlook.com'] } });
    expect(SignupEmailPolicyService.evaluate('a@gmail.com', p).allowed).toBe(true);
    expect(SignupEmailPolicyService.evaluate('a@yahoo.com', p)).toMatchObject({ allowed: false, reason: 'NOT_ALLOWLISTED' });
    expect(SignupEmailPolicyService.evaluate('a@bad.gmail.com', p)).toMatchObject({ allowed: false, reason: 'BLOCKED' });
    expect(SignupEmailPolicyService.evaluate('a@mailinator.com', policy({ allowlist: { enabled: true, domains: ['mailinator.com'] } }))).toMatchObject({ reason: 'BLOCKED' });
  });

  it('an enabled but empty allow list never closes sign-up', () => {
    expect(SignupEmailPolicyService.evaluate('a@yahoo.com', policy({ allowlist: { enabled: true, domains: [] } })).allowed).toBe(true);
  });
});

describe('Admin settings for the sign-up e-mail policy', () => {
  const app = createApp();
  const put = (key: string, value: unknown, token = adminToken) =>
    request(app).put(`/api/v1/admin/ops/settings/${key}`).set('Authorization', `Bearer ${token}`).send({ value });

  it('is ADMIN only', async () => {
    expect((await put('ops.signup.blockedEmailDomains', ['ooynib.com'], ownerToken)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/ops/security/signup-email-policy').set('Authorization', `Bearer ${ownerToken}`)).status).toBe(403);
    expect(settings.size).toBe(0);
  });

  it('saves a normalised, de-duplicated block list and audits it', async () => {
    const res = await put('ops.signup.blockedEmailDomains', [' OOYNIB.com', '@euploading.com', 'ooynib.com']);
    expect(res.status).toBe(200);
    expect(settings.get('ops.signup.blockedEmailDomains')).toEqual(['ooynib.com', 'euploading.com']);
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'SYSTEM_SETTING_UPDATED' }) }));
    expect((await put('ops.signup.blockedEmailDomains', ['ok.com', 'nope'])).status).toBe(400);
  });

  it('refuses to enable the allow list with no domains', async () => {
    const res = await put('ops.signup.emailAllowlist', { enabled: true, domains: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('ít nhất 1 tên miền');
    expect((await put('ops.signup.emailAllowlist', { enabled: true, domains: ['Gmail.com'] })).status).toBe(200);
    expect(settings.get('ops.signup.emailAllowlist')).toEqual({ enabled: true, domains: ['gmail.com'] });
  });

  it('shows every source in one read-only view, including the legacy env list', async () => {
    process.env.SIGNUP_BLOCKED_EMAIL_DOMAINS = 'euploading.com, bad value';
    settings.set('ops.signup.blockedEmailDomains', ['ooynib.com']);
    const res = await request(app).get('/api/v1/admin/ops/security/signup-email-policy').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ envBlocked: ['euploading.com'], adminBlocked: ['ooynib.com'], allowlist: { enabled: false, domains: [] } });
    expect(res.body.data.builtInBlocked).toContain('mailinator.com');
    expect(res.body.data.suggestedAllowlist).toEqual(expect.arrayContaining(['gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com']));
  });
});

describe('Sign-up enforcement (direct API calls)', () => {
  const app = createApp();
  const register = (email: string) =>
    request(app).post('/api/v1/auth/register').send({ fullName: 'Kẻ Phá', email, password: 'Password123!', storeName: 'Shop rác', storeCode: 'shop-rac' });
  const otp = (email: string) => request(app).post('/api/v1/auth/send-register-otp').send({ email });

  it('rejects admin-blocked domains immediately, without a restart', async () => {
    settings.set('ops.signup.blockedEmailDomains', ['ooynib.com']);
    const res = await otp('o1o9uddp4lb@ooynib.com');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('email tạm thời');
    expect((await register('x@mail.ooynib.com')).status).toBe(400);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('allow-list mode rejects other domains with the list in the message', async () => {
    settings.set('ops.signup.emailAllowlist', { enabled: true, domains: ['gmail.com'] });
    const res = await otp('someone@yahoo.com');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Hiện chỉ nhận đăng ký bằng email thuộc: gmail.com.');
  });

  it('when sign-up is switched off, both endpoints refuse before any e-mail check', async () => {
    settings.set('signup.enabled', false);
    expect((await otp('someone@gmail.com')).status).toBe(403);
    const res = await register('someone@gmail.com');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('a corrupt setting row falls back to the safe default instead of blocking everyone', async () => {
    settings.set('ops.signup.emailAllowlist', { enabled: true, domains: 'oops' });
    const res = await otp('someone@yahoo.com');
    expect(res.status).not.toBe(400);
  });
});
