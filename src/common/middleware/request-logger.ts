import { NextFunction, Request, Response } from 'express';
import { logger } from '../logger';
import { HttpMetricsService } from '../services/http-metrics.service';
import { IpActivityService } from '../services/ip-activity.service';
import { readDeviceIdentity } from '../utils/device-identity';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const user = (req as any).user;
    const requestId = (req as any).requestId || req.headers['x-request-id'];
    const latencyMs = Number(elapsedMs.toFixed(2));

    HttpMetricsService.record({ method: req.method, path: req.path, statusCode: res.statusCode, latencyMs, requestId: typeof requestId === 'string' ? requestId : undefined });
    IpActivityService.record({
      ip: req.ip,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      userAgent: req.headers['user-agent'],
      blocked: res.locals.ipBlocked === true,
      ...readDeviceIdentity(req),
    });

    logger.info('http_request_completed', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      latencyMs,
      // Client IP as resolved through `trust proxy`; lets ops grep abusive IPs from `docker logs`.
      ip: req.ip,
      userId: user?.id,
      storeId: user?.storeId,
    });
  });

  next();
}
