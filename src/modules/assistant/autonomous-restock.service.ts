import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';
import { logger } from '../../common/logger';
import { PushNotificationService } from '../../common/services/push-notification.service';
import { InventoryService } from '../inventory/inventory.service';

export type RestockProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface RestockProposal {
  id: string;
  storeId: number;
  stockItemId: number;
  sku: string;
  productName: string;
  currentStock: number;
  minStockLevel: number;
  maxStockLevel: number;
  suggestedQty: number;
  unitCost: number;
  estimatedCost: number;
  avgDailyDemand: number;
  daysOfSupply: number | null;
  aiReason: string;
  status: RestockProposalStatus;
  createdAt: string;
  updatedAt: string;
  approvedQty?: number;
  approvedByUserId?: number;
  approvedAt?: string;
  rejectedByUserId?: number;
  rejectedAt?: string;
}

const MAX_STORED_PROPOSALS = 50;
const PROPOSAL_DEDUP_MS = 12 * 60 * 60 * 1000;

export class AutonomousRestockService {
  private static instance: AutonomousRestockService | null = null;

  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  public static getInstance(prisma: PrismaClient = defaultPrisma): AutonomousRestockService {
    if (!AutonomousRestockService.instance) {
      AutonomousRestockService.instance = new AutonomousRestockService(prisma);
    }
    return AutonomousRestockService.instance;
  }

  private getSettingKey(storeId: number): string {
    return `autonomous_restock_proposals_store_${storeId}`;
  }

  private async readProposals(storeId: number): Promise<RestockProposal[]> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: this.getSettingKey(storeId) },
    });
    if (!setting || !Array.isArray(setting.valueJson)) {
      return [];
    }
    return setting.valueJson as unknown as RestockProposal[];
  }

  private async saveProposals(storeId: number, proposals: RestockProposal[]): Promise<void> {
    const trimmed = proposals.slice(0, MAX_STORED_PROPOSALS);
    const key = this.getSettingKey(storeId);
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: {
        key,
        valueJson: trimmed as unknown as object,
        description: `Pilot AI autonomous restock proposals for store ${storeId}`,
      },
      update: {
        valueJson: trimmed as unknown as object,
      },
    });
  }

  async listProposals(storeId: number, status?: RestockProposalStatus): Promise<RestockProposal[]> {
    const all = await this.readProposals(storeId);
    const filtered = status ? all.filter((p) => p.status === status) : all;
    return filtered.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  /**
   * Event-driven trigger: evaluates stock items after POS sales or inventory movements.
   * When stock drops to or below minStockLevel, drafts an AI restock proposal and pushes to owners.
   */
  async evaluateAndPropose(storeId: number, stockItemIds: number[]): Promise<RestockProposal[]> {
    if (!stockItemIds.length) return [];

    const stockItems = await this.prisma.stockItem.findMany({
      where: {
        storeId,
        id: { in: stockItemIds },
        isActive: true,
      },
      include: {
        balances: true,
      },
    });

    const lowItems = stockItems
      .map((item) => {
        const currentStock = item.balances.reduce((sum, b) => sum + (b.quantity - b.reservedQuantity), 0);
        return { item, currentStock };
      })
      .filter(({ item, currentStock }) => currentStock <= item.minStockLevel);

    if (!lowItems.length) return [];

    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const summaries = await this.prisma.dailySalesSummary.groupBy({
      by: ['stockItemId'],
      where: {
        storeId,
        stockItemId: { in: lowItems.map((x) => x.item.id) },
        summaryDate: { gte: fourteenDaysAgo },
      },
      _sum: { netSoldQty: true },
    });

    const demandByItem = new Map<number, number>();
    for (const row of summaries) {
      const units = Number(row._sum?.netSoldQty || 0);
      demandByItem.set(row.stockItemId, Math.round((units / 14) * 10) / 10);
    }

    const existing = await this.readProposals(storeId);
    const createdForPush: RestockProposal[] = [];
    const now = new Date();
    const nowIso = now.toISOString();

    for (const { item, currentStock } of lowItems) {
      const avgDailyDemand = demandByItem.get(item.id) || 0;
      const targetStock = Math.max(
        item.maxStockLevel || 0,
        item.minStockLevel * 2,
        Math.ceil(avgDailyDemand * 14)
      );
      const suggestedQty = Math.max(1, targetStock - Math.max(0, currentStock));
      const unitCost = Number(item.costPrice || 0);
      const estimatedCost = Math.round(suggestedQty * unitCost);
      const daysOfSupply = avgDailyDemand > 0 ? Math.round((Math.max(0, currentStock) / avgDailyDemand) * 10) / 10 : null;

      const demandNote =
        avgDailyDemand > 0
          ? `Tốc độ bán ~${avgDailyDemand} sp/ngày (còn đủ ~${daysOfSupply} ngày). `
          : '';
      const aiReason = `Tồn kho hiện tại ${currentStock}/${item.minStockLevel} (dưới mức an toàn). ${demandNote}Pilot AI đề xuất nhập ${suggestedQty} sp (dự kiến ${estimatedCost.toLocaleString('vi-VN')}đ).`;

      const existingPendingIdx = existing.findIndex(
        (p) =>
          p.stockItemId === item.id &&
          p.status === 'PENDING' &&
          now.getTime() - new Date(p.createdAt).getTime() < PROPOSAL_DEDUP_MS
      );

      if (existingPendingIdx >= 0) {
        existing[existingPendingIdx] = {
          ...existing[existingPendingIdx],
          currentStock,
          suggestedQty,
          unitCost,
          estimatedCost,
          avgDailyDemand,
          daysOfSupply,
          aiReason,
          updatedAt: nowIso,
        };
      } else {
        const proposal: RestockProposal = {
          id: `AI-PO-${item.id}-${Date.now().toString(36).toUpperCase()}`,
          storeId,
          stockItemId: item.id,
          sku: item.sku,
          productName: item.name,
          currentStock,
          minStockLevel: item.minStockLevel,
          maxStockLevel: item.maxStockLevel,
          suggestedQty,
          unitCost,
          estimatedCost,
          avgDailyDemand,
          daysOfSupply,
          aiReason,
          status: 'PENDING',
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        existing.unshift(proposal);
        createdForPush.push(proposal);
      }
    }

    await this.saveProposals(storeId, existing);

    const pushService = PushNotificationService.getInstance(this.prisma);
    for (const proposal of createdForPush) {
      const costText = proposal.estimatedCost > 0 ? ` (~${proposal.estimatedCost.toLocaleString('vi-VN')}đ)` : '';
      await pushService
        .sendToOwners(storeId, {
          title: `🤖 Pilot AI: Đề xuất nhập ${proposal.productName}`,
          body: `Còn ${proposal.currentStock} sp (mức an toàn ${proposal.minStockLevel}). AI soạn sẵn phiếu nhập ${proposal.suggestedQty} sp${costText}. Mở app để duyệt ngay!`,
          data: {
            type: 'restock_proposal',
            proposalId: proposal.id,
            stockItemId: proposal.stockItemId,
            sku: proposal.sku,
            suggestedQty: proposal.suggestedQty,
          },
          priority: 'high',
        })
        .catch((err) => {
          logger.warn('autonomous_restock_push_failed', { storeId, proposalId: proposal.id, err });
        });
    }

    return createdForPush;
  }

  async approveProposal(
    storeId: number,
    userId: number,
    proposalId: string,
    overrideQty?: number,
    note?: string
  ): Promise<{ proposal: RestockProposal; inventoryResult: unknown }> {
    const proposals = await this.readProposals(storeId);
    const idx = proposals.findIndex((p) => p.id === proposalId);
    if (idx < 0) {
      throw new NotFoundError('Không tìm thấy phiếu đề xuất nhập hàng của AI.');
    }

    const proposal = proposals[idx];
    if (proposal.status !== 'PENDING') {
      throw new ValidationError(`Phiếu đề xuất này đã ở trạng thái ${proposal.status}.`);
    }

    const finalQty = overrideQty !== undefined ? Math.floor(Number(overrideQty)) : proposal.suggestedQty;
    if (!Number.isFinite(finalQty) || finalQty <= 0) {
      throw new ValidationError('Số lượng nhập hàng phải lớn hơn 0.');
    }

    const inventoryService = new InventoryService(this.prisma);
    const inventoryResult = await inventoryService.inflow(storeId, userId, {
      items: [{ stockItemId: proposal.stockItemId, quantity: finalQty }],
      referenceId: proposal.id,
      note: note?.trim() || `Pilot AI tự hành: Duyệt nhập kho từ Mobile App (${proposal.sku})`,
    });

    const nowIso = new Date().toISOString();
    const updated: RestockProposal = {
      ...proposal,
      status: 'APPROVED',
      approvedQty: finalQty,
      approvedByUserId: userId,
      approvedAt: nowIso,
      updatedAt: nowIso,
    };
    proposals[idx] = updated;
    await this.saveProposals(storeId, proposals);

    return { proposal: updated, inventoryResult };
  }

  async rejectProposal(storeId: number, userId: number, proposalId: string): Promise<RestockProposal> {
    const proposals = await this.readProposals(storeId);
    const idx = proposals.findIndex((p) => p.id === proposalId);
    if (idx < 0) {
      throw new NotFoundError('Không tìm thấy phiếu đề xuất nhập hàng của AI.');
    }

    const proposal = proposals[idx];
    if (proposal.status !== 'PENDING') {
      throw new ValidationError(`Phiếu đề xuất này đã ở trạng thái ${proposal.status}.`);
    }

    const nowIso = new Date().toISOString();
    const updated: RestockProposal = {
      ...proposal,
      status: 'REJECTED',
      rejectedByUserId: userId,
      rejectedAt: nowIso,
      updatedAt: nowIso,
    };
    proposals[idx] = updated;
    await this.saveProposals(storeId, proposals);

    return updated;
  }
}
