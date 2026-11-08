/** IP 地址的私网/保留段判定。纯函数,fetcher 的 SSRF 防线。 */

const PRIVATE_V4: ReadonlyArray<[number, number]> = [
  // [网络地址数值, 掩码位数]
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 链路本地(含云元数据 169.254.169.254)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15 基准测试
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 组播
  [0xf0000000, 4], // 240.0.0.0/4 保留
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255 || !/^\d+$/.test(part)) return null;
    value = value * 256 + n;
  }
  return value;
}

function inCidr(value: number, network: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4 映射地址 ::ffff:a.b.c.d → 按 v4 判。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) {
    const v4 = v4ToInt(mapped[1]);
    return v4 != null && PRIVATE_V4.some(([net, bits]) => inCidr(v4, net, bits));
  }
  // fc00::/7 唯一本地;fe80::/10 链路本地;ff00::/8 组播。
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true;
  return false;
}

/** 判定一个 IP 是否私网/保留/链路本地;不认识的格式按公网处理(交给 scheme/解析层兜底)。 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) return isPrivateV6(ip);
  const value = v4ToInt(ip);
  if (value == null) return false;
  return PRIVATE_V4.some(([net, bits]) => inCidr(value, net, bits));
}
