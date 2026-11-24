import { AssistantService } from '../../src/modules/assistant/assistant.service';

describe('AssistantService tax support intent', () => {
  it('answers tax questions from internal TaxSupportService facts', async () => {
    const taxSupport = {
      year: 2026,
      threshold: 1_000_000_000,
      ytdRevenue: 720_000_000,
      ratio: 0.72,
      level: 'WATCH',
      breakdown: { sales: 700_000_000, imported: 20_000_000, returns: 0 },
      priorYearRevenue: 0,
      crossedOn: null,
      registrationDeadlineHint: null,
      forecast: {
        sufficientData: true,
        windowDays: 30,
        avgDailyRevenue: 24_000_000,
        projectedYearEnd: 3_000_000_000,
        projectedCrossDate: '2026-12-01',
      },
      notes: ['Chỉ tính doanh thu ghi nhận trên StockPilot.'],
      generatedAt: '2026-11-24T00:00:00.000Z',
    };
    const taxService = { getRevenueThreshold: jest.fn().mockResolvedValue(taxSupport) };
    const service = new AssistantService({} as any, {} as any, taxService as any);

    const result = await service.answerQuestion(7, 'Doanh thu của tôi đã đạt ngưỡng thuế chưa?', undefined, 'SHOP_OWNER');

    expect(taxService.getRevenueThreshold).toHaveBeenCalledWith(7);
    expect(result.answer).toContain('720.000.000 đ');
    expect(result.answer).toContain('72.0%');
    expect(result.answer).toContain('Đang ở mức cần theo dõi');
    expect(result.dataSnapshot?.taxSupport.level).toBe('WATCH');
    expect(result.dataSnapshot).toEqual({ taxSupport });
  });

  it('does not expose tax revenue facts to warehouse staff', async () => {
    const taxService = { getRevenueThreshold: jest.fn() };
    const service = new AssistantService({} as any, {} as any, taxService as any);

    const result = await service.answerQuestion(7, 'Thuế của cửa hàng là bao nhiêu?', undefined, 'WAREHOUSE_STAFF');

    expect(result.answer).toContain('chỉ được phép tra cứu số lượng tồn kho');
    expect(taxService.getRevenueThreshold).not.toHaveBeenCalled();
  });
});
