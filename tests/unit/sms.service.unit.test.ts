import { sendPasswordResetOtpSms } from '../../src/common/services/sms.service';

describe('OTP SMS delivery safeguards', () => {
  const originalEnv = { ...process.env };
  let consoleLog: jest.SpyInstance;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.SMS_PROVIDER = 'simulation';
    delete process.env.SMS_API_KEY;
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLog.mockRestore();
    process.env = { ...originalEnv };
  });

  it('does not log OTP and reports simulated delivery as not sent', async () => {
    const result = await sendPasswordResetOtpSms({ phone: '0988123456', otp: '123456' });

    expect(result).toEqual({ sent: false, simulated: true });
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
