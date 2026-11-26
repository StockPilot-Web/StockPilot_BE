import { Router } from 'express';
import { ProductController } from './product.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { createProductSchema, updateProductSchema } from './product.schema';
import { productListQuerySchema, idParamSchema } from '../../common/utils/pagination';
import { ForbiddenError } from '../../common/errors/app-error';

export const productRouter = Router();
const controller = new ProductController();

productRouter.use(authMiddleware);
productRouter.use(requireStoreScope);

productRouter.get('/', validate({ query: productListQuerySchema }), (req, res, next) => controller.list(req, res, next));
productRouter.get('/:id', validate({ params: idParamSchema }), (req, res, next) => controller.getById(req, res, next));

// Product master-data creation/deletion is owner-only; Staff may update operational fields where permitted.
productRouter.post('/', requireRole('SHOP_OWNER'), validate({ body: createProductSchema }), (req, res, next) => controller.create(req, res, next));
productRouter.put(
  '/:id',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  (req, _res, next) => {
    if (req.user?.role === 'WAREHOUSE_STAFF' && Object.prototype.hasOwnProperty.call(req.body ?? {}, 'costPrice')) {
      return next(new ForbiddenError('Nhân viên kho không được phép thay đổi giá vốn'));
    }
    return next();
  },
  validate({ params: idParamSchema, body: updateProductSchema }),
  (req, res, next) => controller.update(req, res, next)
);
productRouter.delete('/:id', requireRole('SHOP_OWNER'), validate({ params: idParamSchema }), (req, res, next) => controller.delete(req, res, next));
