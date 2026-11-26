import { Request, Response, NextFunction } from 'express';
import { uploadImageBuffer, getLocalUploadPath } from './upload.service';
import { InvalidFileTypeError } from '../../common/errors/app-error';

function hasSupportedImageSignature(buffer: Buffer): boolean {
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isGif = buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  const isWebp = buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  const isAvif = buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(buffer.subarray(8, 12).toString('ascii'));
  return isJpeg || isPng || isGif || isWebp || isAvif;
}

export class UploadController {
  /**
   * POST /api/v1/upload/image
   * Nhận file ảnh từ multipart/form-data, upload lên Cloudinary, trả về URL
   */
  async uploadImage(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'Vui lòng chọn file ảnh để upload' },
        });
      }

      // Kiểm tra MIME type
      const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
      if (!allowedMimes.includes(req.file.mimetype)) {
        throw new InvalidFileTypeError();
      }

      if (!hasSupportedImageSignature(req.file.buffer)) {
        throw new InvalidFileTypeError('File không phải ảnh hợp lệ hoặc đã bị đổi phần mở rộng. Vui lòng chọn ảnh JPG, PNG, WEBP, GIF hoặc AVIF.');
      }

      // Giới hạn 10MB
      if (req.file.size > 10 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          error: { code: 'FILE_TOO_LARGE', message: 'Ảnh không được lớn hơn 10MB' },
        });
      }

      const result = await uploadImageBuffer(
        req.file.buffer,
        process.env.CLOUDINARY_FOLDER || 'Stockpilot',
        req.file.mimetype
      );

      return res.status(200).json({
        success: true,
        message: 'Upload ảnh thành công',
        data: {
          url: result.secureUrl,
          publicId: result.publicId,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async serveImage(req: Request, res: Response, next: NextFunction) {
    try {
      const filePath = getLocalUploadPath(String(req.params.filename || ''));
      if (!filePath) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Không tìm thấy ảnh' },
        });
      }
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(filePath);
    } catch (error) {
      next(error);
    }
  }
}
