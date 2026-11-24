import { Role } from '@prisma/client';

export type AgentIntent =
  | 'INVENTORY'           // Tồn kho, hết hàng, sắp hết, tồn đọng, nhập kho, vị trí kho
  | 'PRICING_FINANCE'     // Doanh thu, lợi nhuận, giá vốn, giá bán, biên lãi, so sánh tháng
  | 'TAX_SUPPORT'         // Ngưỡng doanh thu, hóa đơn điện tử, sổ doanh thu và câu hỏi thuế
  | 'BUSINESS_STRATEGY'   // Tư vấn kinh doanh, combo, xả hàng kết hợp giá, lập kế hoạch
  | 'GENERAL_CHAT';       // Chào hỏi, thời gian, thông tin trợ lý chung

export interface AgentContext {
  storeId: number;
  question: string;
  normalizedQuestion: string;
  role?: Role;
  userId?: number;
  stockItemId?: number;
  canSeeFinancials: boolean;
  storeContext: any;
  ruleBasedAnalysis: {
    summaryAnswer: string;
    dataSnapshot?: any;
  };
}

export interface SpecialistInsight {
  domain: 'INVENTORY' | 'PRICING_FINANCE' | 'STRATEGY';
  title: string;
  keyMetrics: Record<string, any>;
  findings: string[];
  recommendations: string[];
}
