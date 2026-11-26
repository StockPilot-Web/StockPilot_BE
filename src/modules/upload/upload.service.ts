import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { logger } from '../../common/logger';

const LOCAL_UPLOAD_DIR = path.resolve(process.cwd(), 'data/uploads');
const TMP_UPLOAD_DIR = path.join(os.tmpdir(), 'stockpilot-uploads');

function hasCloudinaryConfig(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME?.trim() &&
      process.env.CLOUDINARY_API_KEY?.trim() &&
      process.env.CLOUDINARY_API_SECRET?.trim()
  );
}

// Cấu hình Cloudinary từ env
if (hasCloudinaryConfig()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

function extFromMime(mimeType?: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    default:
      return 'jpg';
  }
}

async function saveLocalImage(buffer: Buffer, mimeType?: string): Promise<UploadResult> {
  const ext = extFromMime(mimeType);
  const filename = `img_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
  let saved = false;

  for (const dir of [LOCAL_UPLOAD_DIR, TMP_UPLOAD_DIR]) {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, filename), buffer);
      saved = true;
      break;
    } catch (err) {
      logger.warn('local_upload_dir_write_failed', { dir, err });
    }
  }

  if (!saved) {
    throw new Error('Không thể lưu ảnh vào bộ nhớ máy chủ');
  }

  const publicUrl = `/api/v1/upload/files/${filename}`;
  return {
    url: publicUrl,
    secureUrl: publicUrl,
    publicId: filename,
    width: 0,
    height: 0,
    format: ext,
    bytes: buffer.length,
  };
}

export function getLocalUploadPath(filename: string): string | null {
  const safeName = path.basename(String(filename || ''));
  if (!safeName || safeName === '.' || safeName === '..') return null;
  for (const dir of [LOCAL_UPLOAD_DIR, TMP_UPLOAD_DIR]) {
    const fullPath = path.join(dir, safeName);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

export interface UploadResult {
  url: string;
  secureUrl: string;
  publicId: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
}

/**
 * Upload một buffer ảnh lên Cloudinary
 * @param buffer - File buffer từ multer
 * @param folder - Thư mục đích trên Cloudinary
 * @returns UploadResult với URL và metadata ảnh
 */
export async function uploadImageBuffer(
  buffer: Buffer,
  folder = 'stockpilot',
  mimeType?: string,
): Promise<UploadResult> {
  if (!hasCloudinaryConfig()) {
    return saveLocalImage(buffer, mimeType);
  }

  try {
    return await new Promise<UploadResult>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          // Tự động tối ưu format (webp/avif) và chất lượng
          transformation: [
            { quality: 'auto', fetch_format: 'auto', width: 800, crop: 'limit' },
          ],
        },
        (error, result) => {
          if (error) {
            reject(new Error(`Cloudinary upload failed: ${error.message}`));
            return;
          }
          if (!result) {
            reject(new Error('Cloudinary upload returned no result'));
            return;
          }
          resolve({
            url: result.url,
            secureUrl: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            format: result.format,
            bytes: result.bytes,
          });
        },
      );

      uploadStream.end(buffer);
    });
  } catch (err) {
    logger.warn('cloudinary_upload_fallback_local', { err });
    return saveLocalImage(buffer, mimeType);
  }
}

/**
 * Xóa ảnh khỏi Cloudinary theo publicId
 */
export async function deleteImage(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId);
}
