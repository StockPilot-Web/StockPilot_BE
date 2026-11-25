import { z } from 'zod';

const posSaleItemSchema = z
  .object({
    stockItemId: z.number().int().positive(),
    quantity: z.number().int().positive('POS sale quantity must be greater than 0'),
    price: z.coerce.number().min(0).optional(),
    unitPrice: z.coerce.number().min(0).optional(),
  });

export const createPosSaleSchema = z
  .object({
    warehouseId: z.number().int().positive().optional(),
    customerName: z.string().trim().max(255).optional(),
    customerPhone: z.string().trim().max(50).optional(),
    discountAmount: z.coerce.number().min(0).default(0),
    taxAmount: z.coerce.number().min(0).default(0),
    note: z.string().trim().optional(),
    paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'PAYOS', 'MOMO']).default('CASH'),
    totalAmount: z.coerce.number().min(0).optional(),
    items: z.array(posSaleItemSchema).min(1, 'POS sale must contain at least one item'),
  });

export const createMomoPaymentSchema = z.object({
  warehouseId: z.number().int().positive().optional(),
  customerName: z.string().trim().max(255).optional(),
  customerPhone: z.string().trim().max(50).optional(),
  discountAmount: z.coerce.number().min(0).default(0),
  taxAmount: z.coerce.number().min(0).default(0),
  note: z.string().trim().max(1000).optional(),
  paymentMethod: z.literal('MOMO').default('MOMO'),
  totalAmount: z.coerce.number().min(0).optional(),
  items: z.array(z.object({
    stockItemId: z.number().int().positive(),
    quantity: z.number().int().positive(),
  })).min(1),
});

export const createPayosLinkSchema = z.object({
  warehouseId: z.number().int().positive().optional(),
  customerName: z.string().trim().max(255).optional(),
  customerPhone: z.string().trim().max(50).optional(),
  discountAmount: z.coerce.number().min(0).default(0),
  taxAmount: z.coerce.number().min(0).default(0),
  note: z.string().trim().max(1000).optional(),
  items: z.array(z.object({
    stockItemId: z.number().int().positive(),
    quantity: z.number().int().positive(),
  })).min(1),
});

export const momoConfigSchema = z.object({
  partnerCode: z.string().trim().min(1).max(100),
  accessKey: z.string().trim().min(1).max(200),
  secretKey: z.string().trim().max(500).optional().default(''),
  businessName: z.string().trim().min(1).max(255).optional(),
  storeQrId: z.string().trim().max(255).optional(),
  merchantAccount: z.string().trim().max(255).optional(),
  merchantQrCode: z.string().trim().max(500).optional(),
  qrImageUrl: z.string().url().max(1000).optional(),
});

export const momoOrderIdParamSchema = z.object({ momoOrderId: z.string().regex(/^MOMO_[A-Za-z0-9_-]+$/) });
