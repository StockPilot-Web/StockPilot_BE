import type { Request } from 'express';

/**
 * Browser identity sent by the frontend (src/lib/deviceIdentity.js) on every API call:
 * - X-Device-Id: random id kept in the browser's localStorage (precise, gone when site data is cleared)
 * - X-Device-Fp: SHA-256 of hardware/browser traits (GPU, screen, CPU cores, memory, timezone...);
 *   survives clearing site data but identical machines can share it.
 * Browsers cannot read real hardware serials, so these are the strongest "device" signals a web app has.
 * Both are client-supplied: a determined attacker can change them, so they complement IP blocking.
 */
export const DEVICE_ID_HEADER = 'x-device-id';
export const DEVICE_FP_HEADER = 'x-device-fp';

export type DeviceBlockKind = 'DEVICE' | 'FINGERPRINT';

const DEVICE_ID_PATTERN = /^[a-z0-9-]{16,64}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{32,64}$/;

export function normalizeDeviceValue(kind: DeviceBlockKind, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  const pattern = kind === 'DEVICE' ? DEVICE_ID_PATTERN : FINGERPRINT_PATTERN;
  return pattern.test(value) ? value : null;
}

export interface DeviceIdentity {
  deviceId: string | null;
  fingerprint: string | null;
}

export function readDeviceIdentity(req: Pick<Request, 'headers'>): DeviceIdentity {
  const header = (name: string) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    deviceId: normalizeDeviceValue('DEVICE', header(DEVICE_ID_HEADER)),
    fingerprint: normalizeDeviceValue('FINGERPRINT', header(DEVICE_FP_HEADER)),
  };
}
