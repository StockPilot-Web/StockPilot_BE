import { AutonomousRestockService } from '../../src/modules/assistant/autonomous-restock.service';

describe('AutonomousRestockService', () => {
  let mockPrisma: any;
  let service: AutonomousRestockService;

  beforeEach(() => {
    mockPrisma = {
      stockItem: {
        findMany: jest.fn(),
      },
      dailySalesSummary: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 1 }),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service = new AutonomousRestockService(mockPrisma);
  });

  it('creates a PENDING restock proposal when stock drops to or below minStockLevel', async () => {
    mockPrisma.stockItem.findMany.mockResolvedValue([
      {
        id: 42,
        storeId: 1,
        sku: 'SP-042',
        name: 'Sữa tươi Vinamilk 1L',
        minStockLevel: 10,
        maxStockLevel: 50,
        costPrice: 25000,
        isActive: true,
        balances: [{ quantity: 4, reservedQuantity: 0 }],
      },
    ]);
    mockPrisma.dailySalesSummary.groupBy.mockResolvedValue([
      { stockItemId: 42, _sum: { netSoldQty: 28 } },
    ]);

    const created = await service.evaluateAndPropose(1, [42]);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      storeId: 1,
      stockItemId: 42,
      sku: 'SP-042',
      currentStock: 4,
      suggestedQty: 46,
      unitCost: 25000,
      estimatedCost: 1150000,
      avgDailyDemand: 2,
      status: 'PENDING',
    });
    expect(mockPrisma.systemSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects a PENDING proposal cleanly', async () => {
    mockPrisma.systemSetting.findUnique.mockResolvedValue({
      key: 'autonomous_restock_proposals_store_1',
      valueJson: [
        {
          id: 'AI-PO-42-TEST',
          storeId: 1,
          stockItemId: 42,
          sku: 'SP-042',
          productName: 'Sữa tươi Vinamilk 1L',
          currentStock: 4,
          minStockLevel: 10,
          maxStockLevel: 50,
          suggestedQty: 46,
          unitCost: 25000,
          estimatedCost: 1150000,
          avgDailyDemand: 2,
          daysOfSupply: 2,
          aiReason: 'Test',
          status: 'PENDING',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const rejected = await service.rejectProposal(1, 99, 'AI-PO-42-TEST');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectedByUserId).toBe(99);
  });
});
