import { NextFunction, Request, Response } from 'express';
import { DeviceBlockedError, IpBlockedError } from '../errors/app-error';
import { DeviceBlocklistService } from '../services/device-blocklist.service';
import { IpBlocklistService } from '../services/ip-blocklist.service';
import { readDeviceIdentity } from '../utils/device-identity';

/**
 * Rejects requests from a blocked client IP (admin blocklist or BLOCKED_IPS env) or a blocked device
 * (X-Device-Id / X-Device-Fp, see utils/device-identity) before any route work. Uses req.ip, so
 * `trust proxy` (env TRUST_PROXY) must match the real proxy chain. Fails open if a list cannot be loaded.
 */
export async function ipBlockMiddleware(req: Request, res: Response, next: NextFunction) {
  let ipBlocked = false;
  let deviceBlocked = false;
  try {
    ipBlocked = await IpBlocklistService.isBlocked(req.ip);
    if (!ipBlocked) deviceBlocked = (await DeviceBlocklistService.match(readDeviceIdentity(req))) !== null;
  } catch {
    ipBlocked = false;
    deviceBlocked = false;
  }
  if (!ipBlocked && !deviceBlocked) return next();
  res.locals.ipBlocked = true;
  return next(ipBlocked ? new IpBlockedError() : new DeviceBlockedError());
}
