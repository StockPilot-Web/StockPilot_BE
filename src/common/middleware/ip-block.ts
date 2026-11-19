import { NextFunction, Request, Response } from 'express';
import { IpBlockedError } from '../errors/app-error';
import { IpBlocklistService } from '../services/ip-blocklist.service';

/**
 * Rejects requests whose client IP is on the admin blocklist (or BLOCKED_IPS env) before any
 * route work. Uses req.ip, so `trust proxy` (env TRUST_PROXY) must match the real proxy chain.
 * Fails open if the list cannot be loaded (see IpBlocklistService.current).
 */
export async function ipBlockMiddleware(req: Request, res: Response, next: NextFunction) {
  let blocked = false;
  try {
    blocked = await IpBlocklistService.isBlocked(req.ip);
  } catch {
    blocked = false;
  }
  if (!blocked) return next();
  res.locals.ipBlocked = true;
  return next(new IpBlockedError());
}
