import nodemailer from 'nodemailer';
import { sendPasswordResetOtpEmail, sendRegisterOtpEmail } from '../../src/common/services/email.service';

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

const createTransport = nodemailer.createTransport as jest.Mock;

describe('OTP email logging safeguards', () => {
  const originalEnv = { ...process.env };
  let consoleLog: jest.SpyInstance;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_PASS;
    delete process.env.GMAIL_APP_PASSWORD;
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    createTransport.mockReset();
  });

  afterEach(() => {
    consoleLog.mockRestore();
    process.env = { ...originalEnv };
  });

  it('does not log registration OTP when SMTP is not configured', async () => {
    await sendRegisterOtpEmail({ to: 'owner@example.com', name: 'Owner', otp: '123456' });

    expect(consoleLog).not.toHaveBeenCalledWith(expect.stringContaining('123456'));
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('does not log password-reset OTP when SMTP delivery fails', async () => {
    createTransport.mockReturnValue({ sendMail: jest.fn().mockRejectedValue(new Error('smtp unavailable')) });

    process.env.SMTP_USER = 'mailer@example.com';
    process.env.SMTP_PASS = 'secret';
    await sendPasswordResetOtpEmail({ to: 'owner@example.com', name: 'Owner', otp: '654321' });

    expect(consoleLog).not.toHaveBeenCalledWith(expect.stringContaining('654321'));
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
