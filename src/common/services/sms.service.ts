import { logger } from '../logger';
import { ValidationError } from '../errors/app-error';

export interface SendOtpSmsParams {
  phone: string;
  name?: string;
  otp: string;
  expiresMinutes?: number;
}

/**
 * Chuẩn hóa số điện thoại Việt Nam (ví dụ: '0988 123 456' -> '0988123456' hoặc '+84988123456')
 */
export function normalizePhoneNumber(phone: string): string {
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+84')) {
    cleaned = '0' + cleaned.slice(3);
  }
  return cleaned;
}

/**
 * Gửi mã OTP xác thực qua tin nhắn SMS / SMS Gateway
 * Hỗ trợ chế độ giả lập (Simulation) và tích hợp SMS Gateway (eSMS, SpeedSMS, Twilio).
 * Chế độ giả lập không được coi là gửi thành công và không ghi OTP vào log.
 */
export async function sendPasswordResetOtpSms({
  phone,
  otp,
  expiresMinutes = 15,
}: SendOtpSmsParams): Promise<{ sent: boolean; simulated?: boolean }> {
  const normalizedPhone = normalizePhoneNumber(phone);
  const smsProvider = (process.env.SMS_PROVIDER || 'simulation').toLowerCase();
  const smsApiKey = process.env.SMS_API_KEY || '';
  const smsSecret = process.env.SMS_API_SECRET || process.env.SMS_SECRET_KEY || '';

  // Không có gateway thì chỉ ghi nhận trạng thái mô phỏng, tuyệt đối không log OTP.
  if (smsProvider === 'simulation' || !smsApiKey) {
    logger.warn('otp_sms_simulated', { reason: 'sms_gateway_not_configured' });
    return { sent: false, simulated: true };
  }

  // Tích hợp SpeedSMS Gateway nếu có cấu hình
  if (smsProvider === 'speedsms') {
    try {
      const response = await fetch('https://api.speedsms.vn/index.php/sms/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + Buffer.from(`${smsApiKey}:x`).toString('base64'),
        },
        body: JSON.stringify({
          to: [normalizedPhone],
          content: `Ma OTP dat lai mat khau StockPilot cua ban la: ${otp}. Hieu luc trong ${expiresMinutes} phut.`,
          sms_type: 2, // SMS OTP
          sender: process.env.SMS_BRANDNAME || '',
        }),
      });

      const resData = (await response.json()) as any;
      if (resData.status === 'success') {
        logger.info(`[SMS Service] Đã gửi OTP SMS thành công tới ${normalizedPhone}`);
        return { sent: true };
      }
      throw new ValidationError('SpeedSMS từ chối gửi OTP');
    } catch (err: any) {
      logger.error(`[SMS Service] Gửi SMS qua SpeedSMS thất bại: ${err?.message || err}`);
    }
  }

  // Tích hợp eSMS Gateway nếu có cấu hình
  if (smsProvider === 'esms') {
    try {
      const response = await fetch('http://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ApiKey: smsApiKey,
          SecretKey: smsSecret,
          Phone: normalizedPhone,
          Content: `[StockPilot] Ma OTP xac thuc cua ban la ${otp}. Ma co hieu luc trong ${expiresMinutes} phut.`,
          SmsType: '2',
          Brandname: process.env.SMS_BRANDNAME || 'StockPilot',
        }),
      });

      const resData = (await response.json()) as any;
      if (resData.CodeResult === '100') {
        logger.info(`[SMS Service] Đã gửi OTP qua eSMS thành công tới ${normalizedPhone}`);
        return { sent: true };
      }
      throw new ValidationError('eSMS từ chối gửi OTP');
    } catch (err: any) {
      logger.error(`[SMS Service] Gửi SMS qua eSMS thất bại: ${err?.message || err}`);
    }
  }

  logger.warn('otp_sms_delivery_failed', { provider: smsProvider });
  return { sent: false, simulated: true };
}
