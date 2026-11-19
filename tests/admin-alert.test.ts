import { alertAppUrl, resolveAlertRecipients } from '../src/common/services/admin-alert.service';

describe('AdminAlertService addresses', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('prefers ADMIN_ALERT_EMAILS over admin login e-mails', () => {
    expect(resolveAlertRecipients(['admin@stockpilot.vn'], ' Ops@Shop.vn, bad-address , ops@shop.vn,team@shop.vn')).toEqual([
      'ops@shop.vn',
      'team@shop.vn',
    ]);
  });

  it('falls back to valid, de-duplicated admin e-mails when nothing is configured', () => {
    expect(resolveAlertRecipients(['A@x.vn', 'a@x.vn', 'not-an-email'], '')).toEqual(['a@x.vn']);
    expect(resolveAlertRecipients([], undefined)).toEqual([]);
  });

  it('builds links from APP_PUBLIC_URL and never points at localhost unless unset outside production', () => {
    process.env.APP_PUBLIC_URL = 'https://taphoasandg.com/';
    expect(alertAppUrl()).toBe('https://taphoasandg.com');
    delete process.env.APP_PUBLIC_URL;
    process.env.FRONTEND_URL = 'https://app.example.vn';
    expect(alertAppUrl()).toBe('https://app.example.vn');
    delete process.env.FRONTEND_URL;
    // NODE_ENV is 'test' here: dev fallback.
    expect(alertAppUrl()).toBe('http://localhost:5173');
  });
});
