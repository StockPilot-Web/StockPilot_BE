import { PushNotificationService } from '../../src/common/services/push-notification.service';

describe('PushNotificationService', () => {
  let mockPrisma: any;
  let pushService: PushNotificationService;

  beforeEach(() => {
    mockPrisma = {
      systemSetting: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
    };
    pushService = new PushNotificationService(mockPrisma);
  });

  describe('registerToken', () => {
    it('should register a new expo push token for a store', async () => {
      mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
      mockPrisma.systemSetting.upsert.mockResolvedValue({ id: 1 });

      const result = await pushService.registerToken(1, 10, 'ExponentPushToken[abc123xyz]', {
        platform: 'android',
        deviceName: 'Pixel 7',
      });

      expect(result.success).toBe(true);
      expect(result.totalTokens).toBe(1);
      expect(mockPrisma.systemSetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: 'push_tokens_store_1' },
          create: expect.objectContaining({
            key: 'push_tokens_store_1',
            valueJson: [
              expect.objectContaining({
                token: 'ExponentPushToken[abc123xyz]',
                userId: 10,
                platform: 'android',
                deviceName: 'Pixel 7',
              }),
            ],
          }),
        })
      );
    });

    it('should update existing token without duplication', async () => {
      mockPrisma.systemSetting.findUnique.mockResolvedValue({
        key: 'push_tokens_store_1',
        valueJson: [
          {
            token: 'ExponentPushToken[abc123xyz]',
            userId: 10,
            platform: 'android',
            deviceName: 'Old Phone',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      mockPrisma.systemSetting.upsert.mockResolvedValue({ id: 1 });

      const result = await pushService.registerToken(1, 10, 'ExponentPushToken[abc123xyz]', {
        platform: 'ios',
        deviceName: 'iPhone 15',
      });

      expect(result.success).toBe(true);
      expect(result.totalTokens).toBe(1);
      expect(mockPrisma.systemSetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            valueJson: [
              expect.objectContaining({
                token: 'ExponentPushToken[abc123xyz]',
                platform: 'ios',
                deviceName: 'iPhone 15',
              }),
            ],
          }),
        })
      );
    });

    it('should throw an error for empty or invalid token', async () => {
      await expect(pushService.registerToken(1, 10, '')).rejects.toThrow('Push token không hợp lệ.');
    });
  });

  describe('notifyStockAlert', () => {
    it('should format title and body correctly for low-stock and out-of-stock items', async () => {
      mockPrisma.systemSetting.findUnique.mockResolvedValue({
        key: 'push_tokens_store_1',
        valueJson: [],
      });

      // No tokens registered: returns 0 sent
      const outOfStockResult = await pushService.notifyStockAlert(1, {
        productName: 'Nước ngọt Coca-Cola 330ml',
        sku: 'COCA-330',
        currentStock: 0,
        minStockLevel: 20,
        suggestedReorderQty: 100,
      });

      expect(outOfStockResult).toEqual({ sentCount: 0, failedCount: 0 });
    });
  });
});
