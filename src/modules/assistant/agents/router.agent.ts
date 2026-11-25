import { AgentIntent } from './agent.types';

export class RouterAgent {
  /**
   * Phân tích câu hỏi người dùng để định tuyến chính xác đến Agent chuyên môn.
   */
  public static classify(question: string): AgentIntent {
    const q = question.toLowerCase().trim();

    // 1. Luồng kết hợp: số liệu thuế lấy từ StockPilot, phần giải thích có thể nhờ LLM bên ngoài.
    const taxKeywords = [
      'thuế', 'thue', 'hóa đơn điện tử', 'hoa don dien tu', 'hóa đơn máy tính tiền',
      'hoa don may tinh tien', 'ngưỡng doanh thu', 'nguong doanh thu', 'sổ doanh thu',
      'so doanh thu', 's1a', 's2a', 'hộ kinh doanh', 'ho kinh doanh', 'kê khai', 'ke khai',
    ];
    if (taxKeywords.some((k) => q.includes(k))) {
      return 'TAX_SUPPORT';
    }

    // 2. Nhận diện từ khóa Chiến lược Kinh doanh / Đa lĩnh vực (Hybrid)
    const strategyKeywords = [
      'chiến lược', 'tư vấn', 'lập kế hoạch', 'kế hoạch', 'làm sao để',
      'combo', 'kích cầu', 'livestream', 'đề xuất toàn diện', 'tối ưu cửa hàng',
      'phát triển kinh doanh', 'xả hàng'
    ];
    if (strategyKeywords.some((k) => q.includes(k))) {
      return 'BUSINESS_STRATEGY';
    }

    // 3. Nhận diện từ khóa Phân hệ Kho & Tồn kho
    const inventoryKeywords = [
      'kho', 'tồn kho', 'tồn', 'hết hàng', 'sắp hết', 'sắp hết hàng',
      'nhiều tồn', 'tồn nhiều', 'vốn đọng', 'nhập hàng', 'phiếu nhập',
      'phiếu kho', 'kiểm kho', 'mặt hàng', 'sku'
    ];
    const hasInventory = inventoryKeywords.some((k) => q.includes(k));

    // 4. Nhận diện từ khóa Tài chính, Giá bán & Doanh số
    const financialKeywords = [
      'doanh thu', 'doanh số', 'lợi nhuận', 'giá bán', 'giá vốn', 'cogs',
      'biên lợi nhuận', 'chiết khấu', 'khuyến mãi', 'giảm giá', 'tháng',
      'bán chạy', 'bán đắt', 'lãi lỗ', 'tiền bán'
    ];
    const hasFinancial = financialKeywords.some((k) => q.includes(k));

    if (hasInventory && hasFinancial) {
      return 'BUSINESS_STRATEGY';
    }
    if (hasInventory) {
      return 'INVENTORY';
    }
    if (hasFinancial) {
      return 'PRICING_FINANCE';
    }

    // 5. Các câu hỏi chào hỏi, ngày giờ, hoặc hỗ trợ thông thường
    return 'GENERAL_CHAT';
  }
}
