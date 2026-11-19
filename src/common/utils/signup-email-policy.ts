/**
 * Disposable / public-inbox e-mail providers. Anyone can read their inboxes, so the registration OTP
 * proves nothing and scripts use them to mass-create shops (incident 2026-11-19: @mailinator.com).
 * Extend at runtime with SIGNUP_BLOCKED_EMAIL_DOMAINS (comma separated).
 */
export const DEFAULT_BLOCKED_SIGNUP_DOMAINS = [
  'mailinator.com',
  'mailinator.net',
  'mailinator2.com',
  'yopmail.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'sharklasers.com',
  'grr.la',
  '10minutemail.com',
  'temp-mail.org',
  'tempmail.com',
  'trashmail.com',
  'maildrop.cc',
  'getnada.com',
  'dispostable.com',
  'mailnesia.com',
  'mohmal.com',
  'emailondeck.com',
  'throwawaymail.com',
];

function blockedDomains(): string[] {
  const extra = String(process.env.SIGNUP_BLOCKED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  return [...DEFAULT_BLOCKED_SIGNUP_DOMAINS, ...extra];
}

/** True when the e-mail's domain (or a parent domain) is a disposable provider. */
export function isBlockedSignupEmail(email: string): boolean {
  const domain = String(email).trim().toLowerCase().split('@').pop() ?? '';
  if (!domain) return false;
  return blockedDomains().some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}
