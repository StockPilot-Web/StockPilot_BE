import { sendRegisterOtpEmail, sendPasswordResetOtpEmail } from '../../src/common/services/email.service';
import { sendPasswordResetOtpSms } from '../../src/common/services/sms.service';

describe('OTP delivery security', () => {
  it('does not log registration or password-reset OTPs when email delivery is simulated', async () => {
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(sendRegisterOtpEmail({ to: 'user@example.com', otp: '123456' })).resolves.toEqual({ sent: false, simulated: true });
    await expect(sendPasswordResetOtpEmail({ to: 'user@example.com', otp: '654321' })).resolves.toEqual({ sent: false, simulated: true });

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleLog.mock.calls.flat().join(' ')).not.toContain('123456');
    expect(consoleLog.mock.calls.flat().join(' ')).not.toContain('654321');
    consoleLog.mockRestore();
  });

  it('reports simulated SMS delivery as unsent and does not log the OTP', async () => {
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(sendPasswordResetOtpSms({ phone: '0988123456', otp: '112233' })).resolves.toEqual({ sent: false, simulated: true });

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleLog.mock.calls.flat().join(' ')).not.toContain('112233');
    consoleLog.mockRestore();
  });
});
