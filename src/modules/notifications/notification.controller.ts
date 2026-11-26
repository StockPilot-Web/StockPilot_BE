import { Request, Response, NextFunction } from 'express';
import { NotificationService } from './notification.service';
import { prisma } from '../../config/db';
import { canViewFinancials } from '../../common/utils/role-access';
import { PushNotificationService } from '../../common/services/push-notification.service';
import { AutonomousRestockService, RestockProposalStatus } from '../assistant/autonomous-restock.service';

const notificationService = new NotificationService();

export class NotificationController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user?.storeId || 1;
      const result = await notificationService.list(
        storeId,
        req.user!.userId,
        (req as any).validatedQuery || req.query,
        { includePricing: canViewFinancials(req.user!.role) }
      );
      return res.status(200).json({
        success: true,
        data: result.items,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  }

  async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user?.storeId || 1;
      const result = await notificationService.markRead(storeId, req.user!.userId, Number(req.params.id));
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async markAllRead(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user?.storeId || 1;
      const result = await notificationService.markAllRead(storeId, req.user!.userId);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const key = `notifications_store_${storeId}`;
      const record = await prisma.systemSetting.findUnique({ where: { key } });
      const defaultSettings = {
        criticalStockout: true,
        aiPriceSuggestion: true,
        slowMoving: false,
        dailySalesReport: true,
        overstockAlert: true,
      };
      const settings = record ? { ...defaultSettings, ...(record.valueJson as any) } : defaultSettings;
      return res.status(200).json({ success: true, data: settings });
    } catch (error) {
      next(error);
    }
  }

  async updateSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const key = `notifications_store_${storeId}`;
      const saved = await prisma.systemSetting.upsert({
        where: { key },
        create: {
          key,
          valueJson: req.body,
          description: `Notification settings for store ${storeId}`,
          updatedById: userId,
        },
        update: {
          valueJson: req.body,
          updatedById: userId,
        },
      });
      return res.status(200).json({
        success: true,
        message: 'Cập nhật cài đặt thông báo thành công',
        data: saved.valueJson,
      });
    } catch (error) {
      next(error);
    }
  }

  async registerPushToken(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user?.storeId || 1;
      const userId = req.user?.userId || 1;
      const { token, platform, deviceName } = req.body;

      if (!token) {
        return res.status(400).json({ success: false, message: 'Thiếu expo push token.' });
      }

      const pushService = PushNotificationService.getInstance(prisma);
      const result = await pushService.registerToken(storeId, userId, token, {
        platform,
        deviceName,
      });

      return res.status(200).json({
        success: true,
        message: 'Đăng ký nhận thông báo đẩy thành công',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async testPush(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user?.storeId || 1;
      const pushService = PushNotificationService.getInstance(prisma);

      const result = await pushService.sendToStore(storeId, {
        title: '🔔 StockPilot Mobile Alert',
        body: 'Hệ thống thông báo đẩy trên App Mobile đã kết nối thành công!',
        data: { type: 'TEST', timestamp: new Date().toISOString() },
        priority: 'high',
      });

      return res.status(200).json({
        success: true,
        message: 'Đã gửi thông báo kiểm tra đến thiết bị của cửa hàng',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async listRestockProposals(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const status = typeof req.query.status === 'string' ? (req.query.status as RestockProposalStatus) : undefined;
      const proposals = await AutonomousRestockService.getInstance(prisma).listProposals(storeId, status);
      return res.status(200).json({
        success: true,
        data: proposals,
      });
    } catch (error) {
      next(error);
    }
  }

  async approveRestockProposal(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const proposalId = String(req.params.id);
      const quantity = req.body?.quantity !== undefined ? Number(req.body.quantity) : undefined;
      const note = typeof req.body?.note === 'string' ? req.body.note : undefined;

      const result = await AutonomousRestockService.getInstance(prisma).approveProposal(
        storeId,
        userId,
        proposalId,
        quantity,
        note
      );
      return res.status(200).json({
        success: true,
        message: 'Đã duyệt đề xuất nhập hàng và cộng tồn kho thành công',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async rejectRestockProposal(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const proposalId = String(req.params.id);
      const result = await AutonomousRestockService.getInstance(prisma).rejectProposal(storeId, userId, proposalId);
      return res.status(200).json({
        success: true,
        message: 'Đã bỏ qua đề xuất nhập hàng',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}

