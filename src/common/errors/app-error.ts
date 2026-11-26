export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'RATE_LIMITED'
  | 'IP_BLOCKED'
  | 'DEVICE_BLOCKED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: any;

  constructor(message: string, statusCode = 500, code: ErrorCode = 'INTERNAL_ERROR', details?: any) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Dữ liệu không hợp lệ', details?: any) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Dữ liệu gửi lên quá lớn. Vui lòng rút gọn nội dung và thử lại.') {
    super(message, 413, 'PAYLOAD_TOO_LARGE');
  }
}

export class InvalidFileTypeError extends AppError {
  constructor(message = 'File không phải ảnh hợp lệ. Chỉ chấp nhận JPG, PNG, WEBP, GIF hoặc AVIF.') {
    super(message, 400, 'INVALID_FILE_TYPE');
  }
}

export class FileTooLargeError extends AppError {
  constructor(message = 'Ảnh vượt quá giới hạn 10 MB. Vui lòng chọn ảnh nhỏ hơn.') {
    super(message, 413, 'FILE_TOO_LARGE');
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Chưa xác thực hoặc token không hợp lệ') {
    super(message, 401, 'UNAUTHENTICATED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Bạn không có quyền thực hiện hành động này') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Không tìm thấy tài nguyên yêu cầu') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Xung đột dữ liệu hoặc trạng thái không hợp lệ', details?: any) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class InsufficientStockError extends AppError {
  constructor(message = 'Số lượng tồn kho không đủ để thực hiện yêu cầu', details?: any) {
    super(message, 409, 'INSUFFICIENT_STOCK', details);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Bạn đã vượt quá giới hạn sử dụng. Vui lòng thử lại sau.', details?: any) {
    super(message, 429, 'RATE_LIMITED', details);
  }
}

/** Request rejected because the client IP is on the admin blocklist (see ipBlockMiddleware). */
export class IpBlockedError extends AppError {
  constructor(message = 'Truy cập từ địa chỉ IP này đã bị chặn. Liên hệ quản trị viên nếu bạn cho rằng đây là nhầm lẫn.') {
    super(message, 403, 'IP_BLOCKED');
  }
}

/** Request rejected because the client's device id / hardware fingerprint is on the admin blocklist. */
export class DeviceBlockedError extends AppError {
  constructor(message = 'Thiết bị này đã bị chặn truy cập. Liên hệ quản trị viên nếu bạn cho rằng đây là nhầm lẫn.') {
    super(message, 403, 'DEVICE_BLOCKED');
  }
}
