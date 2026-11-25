import { emailDomainOf, matchingRule, normalizeEmailDomain } from './email-domain';

/**
 * Disposable / public-inbox e-mail providers. Anyone can read their inboxes, so the registration OTP
 * proves nothing and scripts use them to mass-create shops (incident 2026-11-19: @mailinator.com).
 * Always blocked. Admins add more at runtime in system_settings `ops.signup.blockedEmailDomains`
 * (see services/signup-email-policy.service.ts); SIGNUP_BLOCKED_EMAIL_DOMAINS (env) is still honoured.
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

/** Domains from the SIGNUP_BLOCKED_EMAIL_DOMAINS env var (comma separated), normalised; invalid ones dropped. */
export function envBlockedSignupDomains(): string[] {
  return String(process.env.SIGNUP_BLOCKED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => normalizeEmailDomain(d))
    .filter((d): d is string => Boolean(d));
}

/** True when the e-mail's domain (or a parent domain) is in the built-in or env block list. */
export function isBlockedSignupEmail(email: string): boolean {
  return matchingRule(emailDomainOf(email), [...DEFAULT_BLOCKED_SIGNUP_DOMAINS, ...envBlockedSignupDomains()]) !== null;
}
