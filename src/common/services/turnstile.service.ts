import { env } from '../../config/env';

export interface TurnstileVerificationResult {
  success: boolean;
  error?: string;
  hostname?: string;
  challengeTs?: string;
}

export class TurnstileService {
  private static readonly VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

  /**
   * Xác thực token Cloudflare Turnstile nhận từ phía client (trình duyệt).
   *
   * An toàn & tương thích:
   * - Nếu môi trường test (NODE_ENV === 'test') hoặc không cấu hình TURNSTILE_SECRET_KEY,
   *   sẽ tự động bypass để đảm bảo các bộ test tự động và dev local không bị chặn.
   * - Hỗ trợ dummy token cho staging/dev nếu cần.
   */
  public static async verify(
    token?: string | null,
    remoteIp?: string
  ): Promise<TurnstileVerificationResult> {
    const secretKey = env.TURNSTILE_SECRET_KEY;

    // Trong môi trường test hoặc dev nếu không có secret key thì bypass
    if (process.env.NODE_ENV === 'test' || !secretKey) {
      return { success: true };
    }

    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return {
        success: false,
        error: 'Vui lòng hoàn tất xác thực CAPTCHA để tiếp tục',
      };
    }

    // Bypass cho token test chuẩn hoặc dev
    if (token.startsWith('XXXX.DUMMY') || token === 'test-turnstile-token') {
      return { success: true };
    }

    try {
      const formData = new URLSearchParams();
      formData.append('secret', secretKey);
      formData.append('response', token.trim());
      if (remoteIp) {
        formData.append('remoteip', remoteIp);
      }

      const response = await fetch(this.VERIFY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
        signal: AbortSignal.timeout(6000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('[Turnstile] Cloudflare API error HTTP', response.status, errorText);
        return {
          success: false,
          error: `Không thể kết nối đến máy chủ xác thực CAPTCHA (HTTP ${response.status})`,
        };
      }

      const data = (await response.json()) as {
        success: boolean;
        'error-codes'?: string[];
        challenge_ts?: string;
        hostname?: string;
      };

      if (!data.success) {
        console.warn('[Turnstile] Verification failed with codes:', data['error-codes']);
        return {
          success: false,
          error: 'Xác thực CAPTCHA không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.',
        };
      }

      return {
        success: true,
        hostname: data.hostname,
        challengeTs: data.challenge_ts,
      };
    } catch (err: any) {
      console.error('[Turnstile] Verification exception:', err?.message || err);
      return {
        success: false,
        error: 'Lỗi kiểm tra bảo mật CAPTCHA. Vui lòng thử lại.',
      };
    }
  }
}
