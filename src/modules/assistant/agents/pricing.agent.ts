import { AgentContext, SpecialistInsight } from './agent.types';

export class PricingAgent {
  /**
   * Chuyên viên Tài chính, Giá bán & Tối ưu Lợi nhuận (Pricing & Financial Specialist).
   * Phân tích doanh thu, chi phí giá vốn (COGS), biên lợi nhuận và hiệu quả từng kỳ kinh doanh.
   */
  public static analyze(ctx: AgentContext): SpecialistInsight {
    if (!ctx.canSeeFinancials) {
      return {
        domain: 'PRICING_FINANCE',
        title: 'Chuyên gia Tài chính & Định giá',
        keyMetrics: {},
        findings: ['Tài khoản không có quyền truy cập dữ liệu tài chính.'],
        recommendations: [],
      };
    }

    const allMonths = ctx.storeContext?.allMonthsPerformance || [];
    const analytics30d = ctx.storeContext?.salesAnalytics30DaysReport;
    const last7d = ctx.storeContext?.last7DaysPerformance;
    const pricing = ctx.storeContext?.pricingOverview;

    const findings: string[] = [];
    const recommendations: string[] = [];

    if (analytics30d) {
      findings.push(
        `Doanh thu 30 ngày qua đạt ${analytics30d.netRevenueFormatted} với lợi nhuận gộp ${analytics30d.grossProfitFormatted} (Biên lợi nhuận: ${analytics30d.profitMarginPct}).`
      );
    }

    if (last7d) {
      findings.push(
        `Doanh thu 7 ngày gần nhất đạt ${last7d.revenue?.toLocaleString('vi-VN')} đ qua ${last7d.ordersCount} đơn hàng, bán ra ${last7d.unitsSold} sản phẩm.`
      );
    }

    if (allMonths && allMonths.length >= 2) {
      const [mCurrent, mPrevious] = allMonths;
      const diffRevenue = mCurrent.totalRevenue - mPrevious.totalRevenue;
      const diffPct = mPrevious.totalRevenue > 0 ? ((diffRevenue / mPrevious.totalRevenue) * 100).toFixed(1) : '0';
      findings.push(
        `So sánh ${mCurrent.month} với ${mPrevious.month}: Doanh thu ${diffRevenue >= 0 ? 'tăng' : 'giảm'} ${Math.abs(diffRevenue).toLocaleString('vi-VN')} đ (${diffRevenue >= 0 ? '+' : ''}${diffPct}%).`
      );
    }

    if (pricing && pricing.pendingApprovalCount > 0) {
      findings.push(
        `Decision Engine có ${pricing.pendingApprovalCount} đề xuất tối ưu giá bán chờ duyệt, dự kiến tăng thêm ${pricing.estimatedMarginUplift} biên lợi nhuận.`
      );
      recommendations.push(`Xem xét duyệt các đề xuất điều chỉnh giá để cải thiện tỷ suất lợi nhuận gộp.`);
    }

    return {
      domain: 'PRICING_FINANCE',
      title: 'Báo cáo Chuyên sâu Tài chính & Tối ưu Giá bán',
      keyMetrics: {
        netRevenue30d: analytics30d?.netRevenueFormatted,
        grossProfit30d: analytics30d?.grossProfitFormatted,
        profitMarginPct: analytics30d?.profitMarginPct,
        pendingPricingCount: pricing?.pendingApprovalCount || 0,
      },
      findings,
      recommendations,
    };
  }
}
