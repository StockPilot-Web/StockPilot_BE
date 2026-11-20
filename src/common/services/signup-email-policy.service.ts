import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ValidationError } from '../errors/app-error';
import { emailDomainOf, matchingRule } from '../utils/email-domain';
import { DEFAULT_BLOCKED_SIGNUP_DOMAINS, envBlockedSignupDomains } from '../utils/signup-email-policy';
import { OpsSettingsService } from './ops-settings.service';

/**
 * Which e-mail domains may create a store. Sources, all enforced together:
 * - built-in disposable providers (utils/signup-email-policy.ts) — always blocked
 * - SIGNUP_BLOCKED_EMAIL_DOMAINS env — still honoured so nothing previously blocked is reopened
 * - system_settings `ops.signup.blockedEmailDomains` — edited by admins at runtime
 * - system_settings `ops.signup.emailAllowlist` — optional "only these domains" mode
 * The block list always wins over the allow list. Settings are read from the database on every sign-up
 * (no cache), so a change applies at once on every running instance.
 */
export const SUGGESTED_ALLOWED_DOMAINS = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'];

type Db = Pick<PrismaClient, 'systemSetting'> | Prisma.TransactionClient;

export interface SignupEmailPolicy {
  builtInBlocked: string[];
  envBlocked: string[];
  adminBlocked: string[];
  allowlist: { enabled: boolean; domains: string[] };
}

export type BlockSource = 'BUILT_IN' | 'ENV' | 'ADMIN';

export type SignupEmailDecision =
  | { allowed: true; domain: string }
  | { allowed: false; domain: string; reason: 'BLOCKED'; rule: string; source: BlockSource }
  | { allowed: false; domain: string; reason: 'NOT_ALLOWLISTED' };

export class SignupEmailPolicyService {
  static async load(db: Db = defaultPrisma): Promise<SignupEmailPolicy> {
    const [adminBlocked, allowlist] = await Promise.all([
      OpsSettingsService.get('ops.signup.blockedEmailDomains', db),
      OpsSettingsService.get('ops.signup.emailAllowlist', db),
    ]);
    return {
      builtInBlocked: [...DEFAULT_BLOCKED_SIGNUP_DOMAINS],
      envBlocked: envBlockedSignupDomains(),
      adminBlocked: [...adminBlocked],
      allowlist: { enabled: allowlist.enabled, domains: [...allowlist.domains] },
    };
  }

  static evaluate(email: string, policy: SignupEmailPolicy): SignupEmailDecision {
    const domain = emailDomainOf(email);
    const sources: [BlockSource, string[]][] = [
      ['BUILT_IN', policy.builtInBlocked],
      ['ENV', policy.envBlocked],
      ['ADMIN', policy.adminBlocked],
    ];
    for (const [source, rules] of sources) {
      const rule = matchingRule(domain, rules);
      if (rule) return { allowed: false, domain, reason: 'BLOCKED', rule, source };
    }
    // Defensive: an enabled allow list with no domains would close sign-up; the setting schema forbids
    // saving it, and a corrupt row falls back to the default (disabled), but never lock out silently.
    if (policy.allowlist.enabled && policy.allowlist.domains.length > 0 && !matchingRule(domain, policy.allowlist.domains)) {
      return { allowed: false, domain, reason: 'NOT_ALLOWLISTED' };
    }
    return { allowed: true, domain };
  }

  /** Throws ValidationError (400) when the e-mail may not be used to create a store. */
  static async assertAllowed(email: string, db: Db = defaultPrisma) {
    const policy = await this.load(db);
    const decision = this.evaluate(email, policy);
    if (decision.allowed) return;
    if (decision.reason === 'BLOCKED') {
      throw new ValidationError('Không chấp nhận email tạm thời/hộp thư công khai. Vui lòng dùng email thật của bạn.');
    }
    throw new ValidationError(`Hiện chỉ nhận đăng ký bằng email thuộc: ${policy.allowlist.domains.join(', ')}.`);
  }
}
