import { AgentContext, AgentIntent, SpecialistInsight } from './agent.types';
import { RouterAgent } from './router.agent';
import { InventoryAgent } from './inventory.agent';
import { PricingAgent } from './pricing.agent';
import { SynthesizerAgent } from './synthesizer.agent';

export interface MultiAgentPlan {
  intent: AgentIntent;
  instructions: string;
  specialists: SpecialistInsight[];
}

export class MultiAgentOrchestrator {
  /**
   * Điều phối quy trình phân tích qua Hệ thống Đa tác tử (Multi-Agent System):
   * 1. Router Agent phân loại ý định người dùng.
   * 2. Gọi song song hoặc tuần tự các Agent chuyên môn (Inventory, Pricing).
   * 3. Synthesizer & Critic Agent tổng hợp kết quả và lập System Prompt tối ưu.
   */
  public static run(ctx: AgentContext): MultiAgentPlan {
    // 1. Phân loại ý định qua Router Agent
    const intent = RouterAgent.classify(ctx.normalizedQuestion);

    const specialists: SpecialistInsight[] = [];

    // 2. Kích hoạt Agent chuyên trách tùy theo ý định
    switch (intent) {
      case 'INVENTORY': {
        const invInsight = InventoryAgent.analyze(ctx);
        specialists.push(invInsight);
        break;
      }
      case 'PRICING_FINANCE': {
        const pricingInsight = PricingAgent.analyze(ctx);
        specialists.push(pricingInsight);
        break;
      }
      case 'BUSINESS_STRATEGY': {
        // Chạy kết hợp cả 2 chuyên gia Kho và Giá/Tài chính
        const invInsight = InventoryAgent.analyze(ctx);
        const pricingInsight = PricingAgent.analyze(ctx);
        specialists.push(invInsight, pricingInsight);
        break;
      }
      case 'GENERAL_CHAT':
      default:
        // Với hội thoại thông thường, không cần nạp phân tích sâu
        break;
    }

    // 3. Synthesizer & Critic Agent xây dựng chỉ dẫn tổng hợp
    const instructions = SynthesizerAgent.buildInstructions(ctx, intent, specialists);

    return {
      intent,
      instructions,
      specialists,
    };
  }
}
