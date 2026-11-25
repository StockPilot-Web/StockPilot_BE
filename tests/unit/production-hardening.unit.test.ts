import { detectAssistantLanguage } from '../../src/modules/assistant/ai-decision.service';
import { createMomoPaymentSchema, momoConfigSchema } from '../../src/modules/pos/pos.schema';

describe('production hardening guards', () => {
  it('detects English questions for multilingual AI output', () => {
    expect(detectAssistantLanguage('Which products are low in stock today?')).toBe('en');
    expect(detectAssistantLanguage('Hàng nào sắp hết kho hôm nay?')).toBe('vi');
  });

  it('does not accept client-controlled payment endpoints or unknown config fields', () => {
    const parsed = momoConfigSchema.parse({
      partnerCode: 'partner',
      accessKey: 'access',
      secretKey: 'secret',
      endpoint: 'http://169.254.169.254/latest/meta-data',
    });

    expect(parsed).not.toHaveProperty('endpoint');
  });

  it('accepts only server-calculated payment inputs', () => {
    const parsed = createMomoPaymentSchema.parse({
      items: [{ stockItemId: 1, quantity: 2, price: 1 }],
      totalAmount: 100,
    });

    expect(parsed.items[0]).not.toHaveProperty('price');
    expect(parsed.totalAmount).toBe(100);
  });
});
