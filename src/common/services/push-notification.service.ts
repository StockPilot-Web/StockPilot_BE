import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { logger } from '../logger';
import { ValidationError } from '../errors/app-error';

export interface PushTokenRecord {
  token: string;
  userId: number;
  platform?: 'ios' | 'android' | 'web';
  deviceName?: string;
  updatedAt: string;
}

export interface PushMessagePayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
}

export interface StockAlertPayload {
  productName: string;
  sku: string;
  currentStock: number;
  minStockLevel: number;
  suggestedReorderQty?: number;
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export class PushNotificationService {
  private static instance: PushNotificationService | null = null;

  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  public static getInstance(prisma: PrismaClient = defaultPrisma): PushNotificationService {
    if (!PushNotificationService.instance) {
      PushNotificationService.instance = new PushNotificationService(prisma);
    }
    return PushNotificationService.instance;
  }

  private getStoreSettingKey(storeId: number): string {
    return `push_tokens_store_${storeId}`;
  }

  /**
   * Register or update an Expo push token for a user/device in a store
   */
  async registerToken(
    storeId: number,
    userId: number,
    token: string,
    meta?: { platform?: 'ios' | 'android' | 'web'; deviceName?: string }
  ): Promise<{ success: boolean; totalTokens: number }> {
    if (!token || typeof token !== 'string') {
      throw new ValidationError('Push token không hợp lệ.');
    }

    const key = this.getStoreSettingKey(storeId);
    const existing = await this.prisma.systemSetting.findUnique({ where: { key } });

    let tokens: PushTokenRecord[] = [];
    if (existing && Array.isArray(existing.valueJson)) {
      tokens = existing.valueJson as unknown as PushTokenRecord[];
    }

    // Upsert token: update if already exists, else append
    const now = new Date().toISOString();
    const index = tokens.findIndex((t) => t.token === token);
    const newRecord: PushTokenRecord = {
      token,
      userId,
      platform: meta?.platform || 'android',
      deviceName: meta?.deviceName || 'Mobile Scanner',
      updatedAt: now,
    };

    if (index >= 0) {
      tokens[index] = newRecord;
    } else {
      tokens.push(newRecord);
    }

    // Keep max 50 active tokens per store to prevent unbound growth
    if (tokens.length > 50) {
      tokens.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      tokens = tokens.slice(0, 50);
    }

    await this.prisma.systemSetting.upsert({
      where: { key },
      create: {
        key,
        valueJson: tokens as any,
        description: `Registered Expo Push Tokens for store ${storeId}`,
        updatedById: userId,
      },
      update: {
        valueJson: tokens as any,
        updatedById: userId,
      },
    });

    return { success: true, totalTokens: tokens.length };
  }

  /**
   * Get all active push tokens for a given store
   */
  async getTokensForStore(storeId: number): Promise<PushTokenRecord[]> {
    const key = this.getStoreSettingKey(storeId);
    const record = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (!record || !Array.isArray(record.valueJson)) {
      return [];
    }
    return record.valueJson as unknown as PushTokenRecord[];
  }

  /**
   * Remove invalid tokens (e.g., DeviceNotRegistered returned by Expo)
   */
  async removeTokens(storeId: number, deadTokens: string[]): Promise<void> {
    if (!deadTokens.length) return;
    const key = this.getStoreSettingKey(storeId);
    const record = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (!record || !Array.isArray(record.valueJson)) return;

    const tokens = (record.valueJson as unknown as PushTokenRecord[]).filter(
      (t) => !deadTokens.includes(t.token)
    );

    await this.prisma.systemSetting.update({
      where: { key },
      data: { valueJson: tokens as any },
    });
  }

  /**
   * Send notification to all registered devices of a store
   */
  async sendToStore(
    storeId: number,
    payload: PushMessagePayload
  ): Promise<{ sentCount: number; failedCount: number }> {
    const records = await this.getTokensForStore(storeId);
    if (!records.length) {
      return { sentCount: 0, failedCount: 0 };
    }

    const messages = records.map((rec) => ({
      to: rec.token,
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      sound: payload.sound ?? 'default',
      priority: payload.priority ?? 'high',
    }));

    return this.sendExpoBatch(storeId, messages);
  }

  /**
   * Send low-stock or critical stockout notification to store mobile app
   */
  async notifyStockAlert(
    storeId: number,
    alert: StockAlertPayload
  ): Promise<{ sentCount: number; failedCount: number }> {
    const isOutOfStock = alert.currentStock <= 0;
    const title = isOutOfStock
      ? `🚨 HẾT HÀNG: ${alert.productName}`
      : `⚠️ Sắp hết hàng: ${alert.productName}`;

    let body = `SKU: ${alert.sku} | Hiện còn: ${alert.currentStock} (Ngưỡng an toàn: ${alert.minStockLevel})`;
    if (alert.suggestedReorderQty && alert.suggestedReorderQty > 0) {
      body += ` | AI đề xuất nhập: ${alert.suggestedReorderQty} cái`;
    }

    return this.sendToStore(storeId, {
      title,
      body,
      priority: 'high',
      sound: 'default',
      data: {
        type: 'STOCK_ALERT',
        sku: alert.sku,
        currentStock: alert.currentStock,
        minStockLevel: alert.minStockLevel,
        suggestedReorderQty: alert.suggestedReorderQty,
      },
    });
  }

  /**
   * Internal helper to dispatch messages to Expo Push API
   */
  private async sendExpoBatch(
    storeId: number,
    messages: Array<{
      to: string;
      title: string;
      body: string;
      data: Record<string, unknown>;
      sound?: 'default' | null;
      priority?: string;
    }>
  ): Promise<{ sentCount: number; failedCount: number }> {
    let sentCount = 0;
    let failedCount = 0;
    const deadTokens: string[] = [];

    // Expo allows up to 100 messages per chunk
    const chunkSize = 100;
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize);
      try {
        const response = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(8000),
        });

        if (!response.ok) {
          logger.warn('expo_push_failed_status', { status: response.status });
          failedCount += chunk.length;
          continue;
        }

        const resData: any = await response.json();
        const tickets = resData.data || [];

        for (let j = 0; j < tickets.length; j++) {
          const ticket = tickets[j];
          if (ticket.status === 'ok') {
            sentCount++;
          } else {
            failedCount++;
            if (
              ticket.details?.error === 'DeviceNotRegistered' ||
              ticket.message?.includes('DeviceNotRegistered')
            ) {
              deadTokens.push(chunk[j].to);
            }
          }
        }
      } catch (err) {
        logger.warn('expo_push_network_error', { err });
        failedCount += chunk.length;
      }
    }

    if (deadTokens.length > 0) {
      await this.removeTokens(storeId, deadTokens).catch(() => {});
    }

    return { sentCount, failedCount };
  }
}
