import net from 'node:net';

/**
 * Fixed non-global/special-use ranges that must never be dialed by an Internet
 * egress proxy. The product uses exact hostname allowlists first; this list is
 * the second, post-DNS fail-closed layer against DNS rebinding and special-use
 * address tricks.
 */
const NON_GLOBAL_IPV4 = new net.BlockList();
const NON_GLOBAL_IPV6 = new net.BlockList();

const IPV4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],        // "this" network / unspecified forms
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // shared/CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local / cloud metadata
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // deprecated 6to4 relay anycast
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmark testing
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + limited broadcast
];

const IPV6_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],               // unspecified
  ['::1', 128],              // loopback
  ['::ffff:0.0.0.0', 96],    // IPv4-mapped forms: require native IPv4 answer instead
  ['64:ff9b::', 96],         // well-known NAT64 translation prefix
  ['64:ff9b:1::', 48],       // local-use NAT64 translation prefix
  ['100::', 64],             // discard-only
  ['2001::', 32],            // Teredo
  ['2001:2::', 48],          // benchmarking
  ['2001:10::', 28],         // deprecated ORCHID
  ['2001:20::', 28],         // ORCHIDv2
  ['2001:db8::', 32],        // documentation
  ['2002::', 16],            // 6to4 (can embed private IPv4)
  ['3fff::', 20],            // documentation
  ['fc00::', 7],             // unique local
  ['fe80::', 10],            // link-local
  ['fec0::', 10],            // deprecated site-local
  ['ff00::', 8],             // multicast
];

for (const [network, prefix] of IPV4_BLOCKS) NON_GLOBAL_IPV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of IPV6_BLOCKS) NON_GLOBAL_IPV6.addSubnet(network, prefix, 'ipv6');

/**
 * Normalize one exact Internet hostname. Wildcards, userinfo, ports, IP
 * literals, Unicode ambiguity, empty labels and single-label names are refused.
 */
export function normalizeExactEgressHostname(value: string): string {
  if (value !== value.trim()) throw new Error('egress hostname must not contain surrounding whitespace');
  const host = value.toLowerCase();
  if (host.length < 1 || host.length > 253) throw new Error('egress hostname length is invalid');
  if (net.isIP(host)) throw new Error('IP literals are not allowed as egress hostnames');
  if (!host.includes('.')) throw new Error('egress hostname must be a fully-qualified multi-label name');
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) throw new Error('egress hostname labels are invalid');
  if (!/^[a-z0-9.-]+$/u.test(host)) throw new Error('egress hostname contains unsupported characters');
  for (const label of host.split('.')) {
    if (label.length < 1 || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) {
      throw new Error('egress hostname label is invalid');
    }
  }
  return host;
}

/**
 * Return true for malformed addresses and every fixed non-global/special-use
 * range. Only syntactically valid IPv4/IPv6 addresses outside the blocklist are
 * considered safe for Internet egress.
 */
export function isUnsafeEgressAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  return family === 4
    ? NON_GLOBAL_IPV4.check(address, 'ipv4')
    : NON_GLOBAL_IPV6.check(address, 'ipv6');
}
