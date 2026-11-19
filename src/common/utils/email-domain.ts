import { z } from 'zod';

/**
 * E-mail domain rules shared by the sign-up block list and allow list.
 *
 * Matching rule (both lists): a rule matches the domain itself and every subdomain of it, on a label
 * boundary. "mailinator.com" matches "mailinator.com" and "x.mailinator.com" but NOT "notmailinator.com".
 */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const TLD = '(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})';
export const EMAIL_DOMAIN_PATTERN = new RegExp(`^(?=.{3,253}$)(?:${LABEL}\\.)+${TLD}$`);

/** Trim, lowercase, drop a leading "@" (people paste "@gmail.com"). Returns null when not a valid domain. */
export function normalizeEmailDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase().replace(/^@+/, '').replace(/\.$/, '');
  return EMAIL_DOMAIN_PATTERN.test(value) ? value : null;
}

/** Domain part of an e-mail address, lowercased; '' when there is none. */
export function emailDomainOf(email: string): string {
  const at = String(email).trim().toLowerCase().lastIndexOf('@');
  return at === -1 ? '' : String(email).trim().toLowerCase().slice(at + 1);
}

export function domainMatches(domain: string, rule: string): boolean {
  return domain === rule || domain.endsWith(`.${rule}`);
}

/** Returns the first rule in `rules` that matches `domain`, or null. */
export function matchingRule(domain: string, rules: Iterable<string>): string | null {
  if (!domain) return null;
  for (const rule of rules) if (domainMatches(domain, rule)) return rule;
  return null;
}

/**
 * Zod schema for an admin-edited domain list: every entry normalised, invalid entries rejected with the
 * offending value in the message, duplicates removed, order kept.
 */
export function emailDomainListSchema(max: number) {
  return z.array(z.string()).max(max, `Tối đa ${max} tên miền`).transform((items, ctx) => {
    const out: string[] = [];
    for (const item of items) {
      const domain = normalizeEmailDomain(item);
      if (!domain) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Tên miền không hợp lệ: "${String(item).slice(0, 80)}"` });
        return z.NEVER;
      }
      if (!out.includes(domain)) out.push(domain);
    }
    return out;
  });
}
