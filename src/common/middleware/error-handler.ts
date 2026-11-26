import { Request, Response, NextFunction } from 'express';
import { AppError, FileTooLargeError, InvalidFileTypeError, PayloadTooLargeError } from '../errors/app-error';
import { env } from '../../config/env';
import { logger } from '../logger';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'unknown';

  if ((err as any).type === 'entity.too.large') {
    err = new PayloadTooLargeError();
  } else if ((err as any).code === 'LIMIT_FILE_SIZE') {
    err = new FileTooLargeError();
  } else if ((err as any).message === 'INVALID_FILE_TYPE') {
    err = new InvalidFileTypeError();
  } else if (err instanceof SyntaxError && (err as any).status === 400) {
    err = new AppError('Dữ liệu JSON không hợp lệ. Vui lòng kiểm tra dấu ngoặc kép và định dạng JSON.', 400, 'VALIDATION_ERROR');
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId,
      },
    });
  }

  if ((err as any).code === 'P2002') {
    return res.status(409).json({
      success: false,
      error: {
        code: 'CONFLICT',
        message: 'Unique constraint conflict',
        requestId,
      },
    });
  }

  if ((err as any).code === 'P2025') {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Requested record was not found',
        requestId,
      },
    });
  }

  // Log unexpected errors
  logger.error('unhandled_request_error', {
    requestId,
    message: err.message,
    error: err,
  });

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Đã xảy ra lỗi máy chủ nội bộ. Vui lòng thử lại sau.',
      requestId,
      ...(env.NODE_ENV === 'development' ? { debug: err.message } : {}),
    },
  });
}
