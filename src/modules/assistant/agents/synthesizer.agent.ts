import { AgentContext, AgentIntent, SpecialistInsight } from './agent.types';

export class SynthesizerAgent {
  /**
   * Synthesizer & Critic Agent: Tổng hợp kết quả từ các Agent chuyên trách,
   * kiểm tra an toàn dữ liệu phân quyền và tạo chỉ dẫn hệ thống (System Prompt) chuẩn mực.
   */
  public static buildInstructions(
    ctx: AgentContext,
    intent: AgentIntent,
    specialists: SpecialistInsight[]
  ): string {
    const isOwner = ctx.canSeeFinancials;

    const roleConstraint = isOwner
      ? 'Đóng vai trò Trợ lý Cá nhân AI đắc lực (Pilot AI) của Chủ cửa hàng. Giao tiếp tự nhiên, tận tâm, xưng "Em" và gọi "Anh/chị".'
      : 'Đóng vai trò Trợ lý Kho AI cho Nhân viên. Tuyệt đối KHÔNG bàn luận về giá vốn, doanh thu, lợi nhuận hay biên lãi. Chỉ tập trung vào số lượng, tồn kho và công việc kho bãi.';

    const specialistSummary = specialists
      .map((s) => `[${s.title}]:\n- ` + s.findings.join('\n- '))
      .join('\n\n');

    const intentSpecificRules = this.getIntentRules(intent, isOwner);

    return [
      'Bạn là Pilot AI — Hệ thống Đa Tác tử (Multi-Agent System) Cố vấn Quản trị Kho & Bán lẻ StockPilot tại Việt Nam.',
      '',
      'VAI TRÒ VÀ NGUYÊN TẮC CỐT LÕI:',
      roleConstraint,
      '',
      'KẾT QUẢ ĐÃ PHÂN TÍCH TỪ CÁC AGENT CHUYÊN TRÁCH:',
      specialistSummary,
      '',
      'CHỈ DẪN NGHIỆP VỤ CHO Ý ĐỊNH NÀY:',
      intentSpecificRules,
      '',
      'QUY TẮC TRÌNH BÀY (CRITIC CHECK):',
      '1. Trả lời đúng trọng tâm câu hỏi của người dùng, không lan man sang các chủ đề không được hỏi.',
      '2. Khi so sánh các tháng, dùng bảng Markdown 4 cột: | Chỉ số kinh doanh | [Tháng X] | [Tháng Y] | Chênh lệch / Xu hướng | (Tuyệt đối không dùng ký tự khối đen hoặc mã html).',
      '3. Số tiền luôn viết dạng chuẩn: ví dụ 25.000 đ hoặc 518.962.200 đ.',
      '4. Ở cuối câu trả lời, hãy luôn hỏi mở 1 câu gợi ý hỗ trợ ấm áp, sẵn sàng giúp đỡ ngay (ví dụ: "Anh/chị cần em hỗ trợ kiểm tra đơn hàng, xem tồn kho hay việc gì khác không ạ?").',
    ].join('\n');
  }

  private static getIntentRules(intent: AgentIntent, isOwner: boolean): string {
    switch (intent) {
      case 'INVENTORY':
        return [
          '- Đây là câu hỏi về Phân hệ Quản lý Kho & Tồn kho của StockPilot.',
          '- Báo cáo trung thực, chính xác 4 chỉ số trụ cột: 1. Tổng giá trị/vốn tồn kho (nếu là chủ shop); 2. Hết hàng (nêu tên cụ thể); 3. Sắp hết hàng (nêu tên cụ thể); 4. Tồn nhiều (nêu tên cụ thể và lượng tồn).',
          '- Tuyệt đối KHÔNG hiểu nhầm sang danh sách nhân sự hay phân quyền nhân viên.',
        ].join('\n');

      case 'PRICING_FINANCE':
        return isOwner
          ? [
              '- Tập trung phân tích sâu doanh thu thực tế, giá vốn, lợi nhuận gộp và biên lợi nhuận.',
              '- Đưa ra nhận xét xu hướng tăng/giảm và 2-3 giải pháp chiến lược tối ưu lợi nhuận cho chủ cửa hàng.',
            ].join('\n')
          : '- Thông báo lịch sự rằng tài khoản nhân viên không có quyền xem dữ liệu tài chính.';

      case 'BUSINESS_STRATEGY':
        return [
          '- Kết hợp nhuần nhuyễn giữa giải phóng hàng tồn nhiều (Inventory) và bảo vệ tỷ suất lợi nhuận (Pricing).',
          '- Đề xuất các combo sản phẩm bán kèm (sản phẩm bán chạy đi kèm sản phẩm tồn nhiều để kích cầu).',
          '- Gợi ý chiến lược giá bán hoặc chương trình ưu đãi khả thi cho chủ cửa hàng.',
        ].join('\n');

      case 'GENERAL_CHAT':
      default:
        return '- Trả lời trực diện, ngắn gọn, thân thiện và lịch sự. Không tự ý chèn báo cáo doanh thu hay tồn kho nếu người dùng không yêu cầu.';
    }
  }
}
