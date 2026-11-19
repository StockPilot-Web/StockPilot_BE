import { normalizeIp } from '../utils/ip-address';

/**
 * In-memory, per-process view of which client IPs are hitting the API right now, so an admin can
 * spot an abusive IP and block it. Kept for the last hour in one-minute buckets, bounded in size.
 * Resets on restart; the durable trail is the audit log (sign-ups, failed logins) and the request log.
 */
export const IP_ACTIVITY_WINDOW_MINUTES = 60;
export const IP_ACTIVITY_MAX_TRACKED = 10_000;

interface Counts {
  requests: number;
  clientErrors: number;
  serverErrors: number;
  rateLimited: number;
  blocked: number;
  authRequests: number;
  signupRequests: number;
}

interface IpRecord {
  firstSeen: number;
  lastSeen: number;
  lastPath: string;
  lastMethod: string;
  lastUserAgent: string | null;
  buckets: Map<number, Counts>;
}

export interface RecordInput {
  ip: string | null | undefined;
  method: string;
  path: string;
  statusCode: number;
  userAgent?: string | null;
  blocked?: boolean;
  now?: number;
}

const emptyCounts = (): Counts => ({
  requests: 0,
  clientErrors: 0,
  serverErrors: 0,
  rateLimited: 0,
  blocked: 0,
  authRequests: 0,
  signupRequests: 0,
});

const SIGNUP_PATH = /\/auth\/(register|send-register-otp)\/?$/;
const AUTH_PATH = /\/auth\//;

export class IpActivityService {
  private static records = new Map<string, IpRecord>();

  static reset() {
    this.records.clear();
  }

  static record(input: RecordInput) {
    const ip = normalizeIp(input.ip);
    if (!ip) return;
    const now = input.now ?? Date.now();
    const minute = Math.floor(now / 60_000);
    const path = (input.path || '').split('?')[0].slice(0, 200);

    let record = this.records.get(ip);
    if (record) {
      // Re-insert so Map order stays least-recently-seen first (cheap LRU eviction below).
      this.records.delete(ip);
    } else {
      record = { firstSeen: now, lastSeen: now, lastPath: path, lastMethod: input.method, lastUserAgent: null, buckets: new Map() };
    }
    record.lastSeen = now;
    record.lastPath = path;
    record.lastMethod = input.method;
    record.lastUserAgent = input.userAgent ? String(input.userAgent).slice(0, 255) : record.lastUserAgent;

    for (const key of record.buckets.keys()) {
      if (key <= minute - IP_ACTIVITY_WINDOW_MINUTES) record.buckets.delete(key);
    }
    const counts = record.buckets.get(minute) ?? emptyCounts();
    counts.requests += 1;
    if (input.statusCode >= 400 && input.statusCode < 500) counts.clientErrors += 1;
    if (input.statusCode >= 500) counts.serverErrors += 1;
    if (input.statusCode === 429) counts.rateLimited += 1;
    if (input.blocked) counts.blocked += 1;
    if (AUTH_PATH.test(path)) counts.authRequests += 1;
    if (SIGNUP_PATH.test(path)) counts.signupRequests += 1;
    record.buckets.set(minute, counts);
    this.records.set(ip, record);

    while (this.records.size > IP_ACTIVITY_MAX_TRACKED) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  /** Top IPs over the last `minutes`, busiest first (ties: most recent first). */
  static top(options: { minutes?: number; limit?: number; now?: number } = {}) {
    const minutes = Math.min(Math.max(options.minutes ?? IP_ACTIVITY_WINDOW_MINUTES, 1), IP_ACTIVITY_WINDOW_MINUTES);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
    const now = options.now ?? Date.now();
    const fromMinute = Math.floor(now / 60_000) - minutes + 1;

    const rows = [];
    for (const [ip, record] of this.records) {
      const total = emptyCounts();
      for (const [minute, counts] of record.buckets) {
        if (minute < fromMinute) continue;
        (Object.keys(total) as (keyof Counts)[]).forEach((key) => {
          total[key] += counts[key];
        });
      }
      if (total.requests === 0) continue;
      rows.push({
        ip,
        ...total,
        firstSeen: new Date(record.firstSeen).toISOString(),
        lastSeen: new Date(record.lastSeen).toISOString(),
        lastMethod: record.lastMethod,
        lastPath: record.lastPath,
        lastUserAgent: record.lastUserAgent,
      });
    }
    rows.sort((a, b) => b.requests - a.requests || b.lastSeen.localeCompare(a.lastSeen));
    return {
      windowMinutes: minutes,
      since: new Date(fromMinute * 60_000).toISOString(),
      trackedIps: this.records.size,
      top: rows.slice(0, limit),
    };
  }
}
