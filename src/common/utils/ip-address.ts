import net from 'node:net';

export type IpFamily = 'ipv4' | 'ipv6';

export interface ParsedIpRange {
  /** Canonical text: a bare address for a single host, `network/prefix` for a range. */
  cidr: string;
  address: string;
  prefix: number;
  family: IpFamily;
}

/** Narrowest ranges an admin may block: wider ranges risk taking out whole carriers or the proxy. */
export const MIN_BLOCK_PREFIX: Record<IpFamily, number> = { ipv4: 16, ipv6: 32 };
const MAX_PREFIX: Record<IpFamily, number> = { ipv4: 32, ipv6: 128 };

/**
 * Normalises a request IP: drops an IPv6 zone id and unwraps IPv4-mapped IPv6 (`::ffff:1.2.3.4`),
 * which Node reports for IPv4 clients on dual-stack sockets. Returns null for anything that is not an IP.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = String(raw).trim();
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1];
  if (net.isIP(value) === 0) return null;
  return net.isIP(value) === 6 ? value.toLowerCase() : value;
}

export function ipFamily(ip: string): IpFamily {
  return net.isIP(ip) === 6 ? 'ipv6' : 'ipv4';
}

/** Zeroes the host bits so `10.1.2.3/16` and `10.1.0.0/16` are stored as the same range. */
function networkAddress(address: string, prefix: number, family: IpFamily): string {
  if (family === 'ipv4') {
    const octets = address.split('.').map(Number);
    const value = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (value & mask) >>> 0;
    return [network >>> 24, (network >>> 16) & 255, (network >>> 8) & 255, network & 255].join('.');
  }
  // IPv6: expand, mask per 16-bit group, then let SocketAddress print the compressed form.
  const groups = expandIpv6(address);
  const masked = groups.map((group, index) => {
    const bitsLeft = Math.max(0, Math.min(16, prefix - index * 16));
    const mask = bitsLeft === 0 ? 0 : (0xffff << (16 - bitsLeft)) & 0xffff;
    return group & mask;
  });
  return new net.SocketAddress({ address: masked.map((g) => g.toString(16)).join(':'), family: 'ipv6' }).address;
}

function expandIpv6(address: string): number[] {
  let text = address;
  // An embedded IPv4 tail (e.g. ::ffff:1.2.3.4) becomes two hex groups.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    text = text.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const all = text.includes('::') ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups] : headGroups;
  return all.map((g) => parseInt(g || '0', 16));
}

/**
 * Parses what an admin typed: a single IP (`203.0.113.7`, `2001:db8::1`) or a CIDR range
 * (`203.0.113.0/24`). Throws a plain Error with a Vietnamese message the caller turns into a 400.
 */
export function parseIpOrCidr(input: string): ParsedIpRange {
  const text = String(input ?? '').trim();
  const [rawAddress, rawPrefix, extra] = text.split('/');
  if (extra !== undefined) throw new Error('Địa chỉ IP/CIDR không hợp lệ');

  const address = normalizeIp(rawAddress);
  if (!address) throw new Error('Địa chỉ IP/CIDR không hợp lệ');
  const family = ipFamily(address);

  let prefix = MAX_PREFIX[family];
  if (rawPrefix !== undefined) {
    if (!/^\d{1,3}$/.test(rawPrefix)) throw new Error('Độ dài prefix CIDR không hợp lệ');
    prefix = Number(rawPrefix);
    if (prefix > MAX_PREFIX[family]) throw new Error('Độ dài prefix CIDR không hợp lệ');
  }
  if (prefix < MIN_BLOCK_PREFIX[family]) {
    throw new Error(`Dải IP quá rộng: tối thiểu /${MIN_BLOCK_PREFIX[family]} cho ${family === 'ipv4' ? 'IPv4' : 'IPv6'}`);
  }

  const network = prefix === MAX_PREFIX[family] ? address : networkAddress(address, prefix, family);
  return {
    address: network,
    prefix,
    family,
    cidr: prefix === MAX_PREFIX[family] ? network : `${network}/${prefix}`,
  };
}

/** True when `ip` falls inside the parsed range. */
export function rangeContains(range: ParsedIpRange, ip: string | null | undefined): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  const list = new net.BlockList();
  list.addSubnet(range.address, range.prefix, range.family);
  return list.check(normalized, ipFamily(normalized));
}

export function isLoopback(ip: string | null | undefined): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  return normalized === '::1' || normalized.startsWith('127.');
}
