import { AgentContext, SpecialistInsight } from './agent.types';

export class InventoryAgent {
  /**
   * Chuyên viên Quản lý Kho & Tồn kho (Inventory Specialist).
   * Phân tích chuyên sâu 4 trụ cột KPI kho, cảnh báo rủi ro đứt gãy và đề xuất nhập hàng.
   */
  public static analyze(ctx: AgentContext): SpecialistInsight {
    const raw = ctx.storeContext?.inventoryOverview?.warehouseKpis || {};
    const overview = ctx.storeContext?.inventoryOverview || {};
    const alerts = ctx.storeContext?.activeAlerts || [];

    const totalPhysicalUnits = raw.totalPhysicalUnits ?? overview.totalPhysicalQuantityOnHand ?? 0;
    const totalProducts = raw.totalProducts ?? overview.totalProductsCount ?? 0;

    const outOfStockCount = raw.outOfStock?.count ?? overview.outOfStockCount ?? 0;
    const outOfStockItems = raw.outOfStock?.sampleItems || overview.outOfStockItemsSample || [];

    const lowStockCount = raw.lowStock?.count ?? overview.lowStockCount ?? 0;
    const lowStockItems = raw.lowStock?.sampleItems || overview.lowStockItemsSample || [];

    const overStockCount = raw.overStock?.count ?? overview.overStockCount ?? 0;
    const overStockItems = raw.overStock?.sampleItems || overview.overStockItemsSample || [];

    const findings: string[] = [];
    const recommendations: string[] = [];

    findings.push(`Tổng số lượng hàng hóa vật lý trong kho: ${totalPhysicalUnits.toLocaleString('vi-VN')} đơn vị trên ${totalProducts} mặt hàng.`);

    if (outOfStockCount > 0) {
      const sampleNames = outOfStockItems.map((it: any) => `${it.name} (${it.sku})`).join(', ');
      findings.push(`🔴 Hết hàng hoàn toàn: ${outOfStockCount} sản phẩm cần nhập gấp (${sampleNames}).`);
      recommendations.push(`Khởi tạo ngay phiếu nhập kho bổ sung cho ${outOfStockCount} mặt hàng đang hết để tránh mất doanh thu.`);
    }

    if (lowStockCount > 0) {
      const sampleNames = lowStockItems.map((it: any) => `${it.name} (${it.sku} - còn ${it.quantity})`).join(', ');
      findings.push(`🟠 Sắp hết hàng (dưới ngưỡng an toàn): ${lowStockCount} sản phẩm (${sampleNames}).`);
      recommendations.push(`Liên hệ nhà cung cấp đặt hàng trước cho các mặt hàng sắp hết trước khi rơi vào tình trạng đứt hàng.`);
    }

    if (overStockCount > 0) {
      const sampleNames = overStockItems.slice(0, 3).map((it: any) => `${it.name} (${it.sku} - tồn ${it.quantity})`).join(', ');
      findings.push(`🔵 Tồn kho quá mức (gây đọng vốn): ${overStockCount} sản phẩm (${sampleNames}...).`);
      recommendations.push(`Tạo chương trình ưu đãi, combo hoặc điều chỉnh nhẹ giá bán để giải phóng dòng tiền từ hàng tồn nhiều.`);
    }

    return {
      domain: 'INVENTORY',
      title: 'Báo cáo Chuyên sâu Phân hệ Kho & Tồn kho',
      keyMetrics: {
        totalPhysicalUnits,
        totalProducts,
        outOfStockCount,
        lowStockCount,
        overStockCount,
        totalInventoryCost: ctx.canSeeFinancials ? raw.totalInventoryCostValueFormatted : undefined,
      },
      findings,
      recommendations,
    };
  }
}
