import {
  FileTooLargeError,
  InvalidFileTypeError,
  PayloadTooLargeError,
} from '../src/common/errors/app-error';
import { errorHandler } from '../src/common/middleware/error-handler';
import { createProductSchema } from '../src/modules/products/product.schema';
import { updateProfileSchema, updateStoreSchema } from '../src/modules/auth/auth.schema';
import { CategoryService } from '../src/modules/categories/category.service';

describe('Sprint 1 clear error contracts', () => {
  it('returns a structured 413 response for oversized JSON bodies', () => {
    const req = { headers: {}, requestId: 'req-413' } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as any;

    errorHandler({ type: 'entity.too.large' } as any, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Dữ liệu gửi lên quá lớn. Vui lòng rút gọn nội dung và thử lại.',
        requestId: 'req-413',
      }),
    }));
  });

  it('maps Multer size and type failures to explicit error codes', () => {
    expect(new FileTooLargeError().code).toBe('FILE_TOO_LARGE');
    expect(new InvalidFileTypeError().code).toBe('INVALID_FILE_TYPE');
    expect(new PayloadTooLargeError().statusCode).toBe(413);
  });

  it('reports duplicate barcodes by variant instead of accepting the request', () => {
    const result = createProductSchema.safeParse({
      name: 'Test Product',
      code: 'SP1',
      items: [
        { sku: 'SP1', name: 'Variant 1', barcode: '8930001', costPrice: 1, sellingPrice: 2 },
        { sku: 'SP2', name: 'Variant 2', barcode: '8930001', costPrice: 1, sellingPrice: 2 },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['items', 1, 'barcode'],
          message: 'Mã vạch bị trùng với biến thể 1 trong cùng biểu mẫu',
        }),
      ]));
    }
  });

  it('rejects whitespace-only or malformed phone values with a field-level message', () => {
    expect(() => updateProfileSchema.parse({ phone: '         ' })).toThrow('Số điện thoại phải có ít nhất 9 chữ số');
    expect(() => updateStoreSchema.parse({ phone: 'phone-number' })).toThrow('Số điện thoại chỉ được chứa chữ số và ký hiệu điện thoại hợp lệ');
  });

  it('rejects duplicate category names before attempting to write', async () => {
    const category = {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue({ id: 10 }),
      create: jest.fn(),
    };
    const prisma = {
      category,
      $transaction: jest.fn(async (callback: any) => callback({ category, auditLog: { create: jest.fn() } })),
    } as any;
    const service = new CategoryService(prisma);

    await expect(service.createCategory(1, { code: 'CAT1', name: ' Test ' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Tên danh mục "Test" đã tồn tại trong cửa hàng. Vui lòng chọn tên khác.',
    });
    expect(category.create).not.toHaveBeenCalled();
  });
});
