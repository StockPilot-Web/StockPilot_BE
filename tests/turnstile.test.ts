import { TurnstileService } from '../src/common/services/turnstile.service';

describe('TurnstileService', () => {
  it('tự động bypass khi NODE_ENV === test', async () => {
    const result = await TurnstileService.verify(undefined);
    expect(result.success).toBe(true);
  });

  it('chấp nhận dummy test token khi bypass', async () => {
    const result = await TurnstileService.verify('XXXX.DUMMY.TOKEN');
    expect(result.success).toBe(true);
  });
});

