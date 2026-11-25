import { RouterAgent } from '../../src/modules/assistant/agents/router.agent';
import { InventoryAgent } from '../../src/modules/assistant/agents/inventory.agent';
import { PricingAgent } from '../../src/modules/assistant/agents/pricing.agent';
import { SynthesizerAgent } from '../../src/modules/assistant/agents/synthesizer.agent';
import { MultiAgentOrchestrator } from '../../src/modules/assistant/agents/multi-agent.orchestrator';

describe('Multi-Agent System (Tier 1 AI)', () => {
  describe('RouterAgent', () => {
    it('phân loại chính xác câu hỏi về Kho & Tồn kho', () => {
      expect(RouterAgent.classify('Kiểm tra hàng tồn kho còn bao nhiêu?')).toBe('INVENTORY');
      expect(RouterAgent.classify('Có mặt hàng nào bị hết hàng không?')).toBe('INVENTORY');
      expect(RouterAgent.classify('Sản phẩm nào sắp hết hàng cần nhập?')).toBe('INVENTORY');
    });

    it('phân loại chính xác câu hỏi về Doanh thu & Giá bán', () => {
      expect(RouterAgent.classify('Doanh thu tháng này đạt bao nhiêu?')).toBe('PRICING_FINANCE');
      expect(RouterAgent.classify('Lợi nhuận gộp của cửa hàng là bao nhiêu?')).toBe('PRICING_FINANCE');
      expect(RouterAgent.classify('So sánh doanh thu tháng 8 và tháng 9')).toBe('PRICING_FINANCE');
    });

    it('phân loại câu hỏi kết hợp vào Chiến lược kinh doanh (Strategy)', () => {
      expect(RouterAgent.classify('Làm sao để xả hàng tồn nhiều mà vẫn giữ được lợi nhuận?')).toBe('BUSINESS_STRATEGY');
      expect(RouterAgent.classify('Tư vấn chiến lược kinh doanh và combo kích cầu')).toBe('BUSINESS_STRATEGY');
    });

    it('định tuyến câu hỏi thuế vào luồng kết hợp nội bộ + AI bên ngoài', () => {
      expect(RouterAgent.classify('Doanh thu cửa hàng đã vượt ngưỡng hóa đơn điện tử chưa?')).toBe('TAX_SUPPORT');
      expect(RouterAgent.classify('Tôi cần xem sổ doanh thu S1a')).toBe('TAX_SUPPORT');
    });

    it('phân loại câu chào hỏi thông thường vào General Chat', () => {
      expect(RouterAgent.classify('Xin chào, bạn tên là gì?')).toBe('GENERAL_CHAT');
      expect(RouterAgent.classify('Hôm nay là thứ mấy?')).toBe('GENERAL_CHAT');
    });
  });

  describe('InventoryAgent', () => {
    it('trích xuất đúng 4 trụ cột KPI kho hàng', () => {
      const mockContext: any = {
        canSeeFinancials: true,
        storeContext: {
          inventoryOverview: {
            warehouseKpis: {
              totalPhysicalUnits: 1500,
              totalProducts: 50,
              outOfStock: { count: 2, sampleItems: [{ name: 'Sữa tươi', sku: 'SKU-1' }] },
              lowStock: { count: 3, sampleItems: [{ name: 'Bánh mì', sku: 'SKU-2', quantity: 1 }] },
              overStock: { count: 10, sampleItems: [{ name: 'Kẹo', sku: 'SKU-3', quantity: 100 }] },
              totalInventoryCostValueFormatted: '50.000.000 đ',
            },
          },
        },
      };

      const result = InventoryAgent.analyze(mockContext);
      expect(result.domain).toBe('INVENTORY');
      expect(result.keyMetrics.totalPhysicalUnits).toBe(1500);
      expect(result.keyMetrics.outOfStockCount).toBe(2);
      expect(result.findings.some((f) => f.includes('Hết hàng'))).toBe(true);
      expect(result.findings.some((f) => f.includes('Sắp hết'))).toBe(true);
    });
  });

  describe('PricingAgent', () => {
    it('từ chối phân tích số liệu tài chính nếu là nhân viên kho', () => {
      const mockContext: any = { canSeeFinancials: false };
      const result = PricingAgent.analyze(mockContext);
      expect(result.findings[0]).toContain('không có quyền truy cập');
    });

    it('phân tích doanh thu và biên lợi nhuận cho chủ cửa hàng', () => {
      const mockContext: any = {
        canSeeFinancials: true,
        storeContext: {
          salesAnalytics30DaysReport: {
            netRevenueFormatted: '100.000.000 đ',
            grossProfitFormatted: '30.000.000 đ',
            profitMarginPct: '30%',
          },
          allMonthsPerformance: [
            { month: 'Tháng 10', totalRevenue: 120000000 },
            { month: 'Tháng 9', totalRevenue: 100000000 },
          ],
        },
      };

      const result = PricingAgent.analyze(mockContext);
      expect(result.domain).toBe('PRICING_FINANCE');
      expect(result.keyMetrics.profitMarginPct).toBe('30%');
      expect(result.findings.some((f) => f.includes('100.000.000 đ'))).toBe(true);
    });
  });

  describe('MultiAgentOrchestrator', () => {
    it('điều phối luồng đa tác tử và sinh system prompt đầy đủ', () => {
      const mockContext: any = {
        storeId: 1,
        question: 'Tình trạng hàng tồn kho hôm nay thế nào?',
        normalizedQuestion: 'tình trạng hàng tồn kho hôm nay thế nào?',
        role: 'SHOP_OWNER',
        canSeeFinancials: true,
        storeContext: {
          inventoryOverview: {
            warehouseKpis: { totalPhysicalUnits: 500, outOfStock: { count: 0 }, lowStock: { count: 0 }, overStock: { count: 0 } },
          },
        },
        ruleBasedAnalysis: { summaryAnswer: 'Kho ổn định' },
      };

      const plan = MultiAgentOrchestrator.run(mockContext);
      expect(plan.intent).toBe('INVENTORY');
      expect(plan.specialists.length).toBe(1);
      expect(plan.specialists[0].domain).toBe('INVENTORY');
      expect(plan.instructions).toContain('Multi-Agent System');
      expect(plan.instructions).toContain('Pilot AI');
    });
  });
});
