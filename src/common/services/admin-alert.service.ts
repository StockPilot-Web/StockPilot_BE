import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { logger } from '../logger';
import { sendPlatformEmail } from './email.service';

const EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * Who receives platform alerts. ADMIN_ALERT_EMAILS (comma separated) wins: admin login e-mails are
 * often placeholders (the seed admin is admin@stockpilot.vn, a domain the project does not own), and
 * alerts carry customer names/phones, so they must only go to a mailbox the team controls.
 */
export function resolveAlertRecipients(adminEmails: string[], configured = process.env.ADMIN_ALERT_EMAILS): string[] {
  const fromEnv = String(configured ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => EMAIL_PATTERN.test(email));
  const source = fromEnv.length > 0 ? fromEnv : adminEmails.map((email) => email.trim().toLowerCase());
  return [...new Set(source.filter((email) => EMAIL_PATTERN.test(email)))];
}

/**
 * Base URL for links in alert e-mails: APP_PUBLIC_URL / FRONTEND_URL, else the production root domain
 * (never localhost in production), else the Vite dev server.
 */
export function alertAppUrl(): string {
  const configured = process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL;
  const fallback = env.NODE_ENV === 'production' ? `https://${env.TENANT_ROOT_DOMAIN}` : 'http://localhost:5173';
  return (configured || fallback).replace(/\/+$/, '');
}

/**
 * Tells the platform team about events that need a human (new lead, new or answered support ticket).
 * Fire-and-forget: never throws and never delays the request that triggered it.
 */
export const AdminAlertService = {
  notify(subject: string, lines: string[], path: string) {
    if (env.NODE_ENV === 'test') return;
    void (async () => {
      try {
        const configured = resolveAlertRecipients([]);
        const recipients =
          configured.length > 0
            ? configured
            : resolveAlertRecipients(
                (await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { email: true } })).map((a) => a.email)
              );
        if (recipients.length === 0) {
          logger.warn('admin_alert_no_recipients', { subject });
          return;
        }
        const link = `${alertAppUrl()}${path}`;
        await sendPlatformEmail({
          to: recipients,
          subject: `[StockPilot Admin] ${subject}`,
          text: [...lines, '', `Xem chi tiết: ${link}`].join('\n'),
        });
      } catch (err: any) {
        logger.warn('admin_alert_failed', { subject, message: err?.message });
      }
    })();
  },
};
