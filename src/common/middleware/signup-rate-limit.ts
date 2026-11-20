import { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { RateLimitedError } from '../errors/app-error';

/**
 * Per-IP limiter for account creation (`/auth/send-register-otp`, `/auth/register`).
 * These endpoints were not rate limited at all: a script could create shops or send OTP emails
 * in a loop. Errors go through the central handler (`{ success: false, error: { code: 'RATE_LIMITED' } }`).
 */
export function createSignupRateLimiter(options: { windowMs: number; max: number }): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, _res: Response, next: NextFunction) =>
      next(new RateLimitedError('Bạn đã thử đăng ký quá nhiều lần từ địa chỉ này. Vui lòng thử lại sau.')),
  });
}
