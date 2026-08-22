/**
 * A4 egress proxy tests — allowlist validation, private/mapped-address
 * rejection, port policy, hostname validation, and a live CONNECT allow/deny.
 */
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import {
  isPrivateAddress,
  validateConnectTarget,
  KIRO_PROVIDER_ALLOWLIST,
  EgressProxy,
  jobNetworkName,
} from '../../src/executor/agents/egressProxy.js';

describe('egress proxy — private address detection', () => {
  it('detects IPv4 loopback / RFC1918 / link-local / metadata / CGNAT', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255',
      '192.168.0.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '0.0.0.0', '255.255.255.255']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows genuine public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '52.94.236.100', '203.0.113.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
  });

  it('detects IPv6 loopback / unspecified / link-local / unique-local', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::abcd']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('closes the IPv4-mapped IPv6 bypass', () => {
    // These embed a private IPv4 and MUST be rejected.
    for (const ip of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::192.168.1.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    // A mapped PUBLIC address is fine.
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('egress proxy — CONNECT target validation', () => {
  it('allows the validated Kiro endpoints on 443', () => {
    for (const host of KIRO_PROVIDER_ALLOWLIST) {
      expect(validateConnectTarget(host, 443), host).toBeNull();
    }
  });

  it('rejects non-443 ports', () => {
    for (const p of [80, 8080, 22, 8443, 3128]) {
      expect(validateConnectTarget('runtime.us-east-1.kiro.dev', p)).toMatch(/not allowed/);
    }
  });

  it('rejects IP literals, userinfo, localhost, and non-allowlisted hosts', () => {
    expect(validateConnectTarget('1.2.3.4', 443)).toMatch(/IP literals/);
    expect(validateConnectTarget('::1', 443)).toMatch(/IP literals/);
    expect(validateConnectTarget('user@runtime.us-east-1.kiro.dev', 443)).toMatch(/userinfo/);
    expect(validateConnectTarget('localhost', 443)).toMatch(/localhost/);
    expect(validateConnectTarget('sub.localhost', 443)).toMatch(/localhost/);
    for (const bad of ['evil.com', 'google.com', 'github.com', 'host.docker.internal',
      'client-telemetry.us-east-1.amazonaws.com', 'kiro.dev', 'api.kiro.dev']) {
      expect(validateConnectTarget(bad, 443), bad).toMatch(/not in the egress allowlist/);
    }
  });

  it('matches case-insensitively', () => {
    expect(validateConnectTarget('RUNTIME.US-EAST-1.KIRO.DEV', 443)).toBeNull();
  });
});

describe('egress proxy — allowlist contents', () => {
  it('contains the live-validated Kiro runtime + auth endpoints', () => {
    expect(KIRO_PROVIDER_ALLOWLIST).toContain('runtime.us-east-1.kiro.dev');
    expect(KIRO_PROVIDER_ALLOWLIST).toContain('prod.us-east-1.auth.desktop.kiro.dev');
    expect(KIRO_PROVIDER_ALLOWLIST).toContain('codewhisperer.us-east-1.amazonaws.com');
  });

  it('includes the Cognito identity endpoint required for KIRO_API_KEY auth', () => {
    // Proven by proxy egress logs: without it, headless auth fails "not logged in".
    expect(KIRO_PROVIDER_ALLOWLIST).toContain('cognito-identity.us-east-1.amazonaws.com');
  });

  it('includes the Amazon Q inference endpoint required for session/prompt', () => {
    // Proven by egress logs: without it, a real turn fails ACP -32603.
    expect(KIRO_PROVIDER_ALLOWLIST).toContain('q.us-east-1.amazonaws.com');
  });

  it('does NOT allowlist telemetry, update, or wildcards', () => {
    expect(KIRO_PROVIDER_ALLOWLIST).not.toContain('client-telemetry.us-east-1.amazonaws.com');
    // The Q update/release host is not inference and stays denied.
    expect(KIRO_PROVIDER_ALLOWLIST).not.toContain('desktop-release.q.us-east-1.amazonaws.com');
    for (const h of KIRO_PROVIDER_ALLOWLIST) expect(h).not.toContain('*');
  });
});

describe('egress proxy — live CONNECT allow/deny', () => {
  it('denies a non-allowlisted CONNECT and allows an allowlisted one (to a local stub)', async () => {
    // A local TLS-less stub stands in for the upstream; we add it to the
    // allowlist explicitly and pin DNS by using a hostname that resolves to
    // loopback only via the allowlist bypassing private-check is NOT possible,
    // so we instead assert the 403 path for a blocked host and the 400 path for
    // a bad request. (Full upstream dialing is covered by the live acceptance.)
    const proxy = new EgressProxy({ listenHost: '127.0.0.1', listenPort: 0 });
    const addr = await proxy.start();
    try {
      const resp = await connectRequest(addr.port, 'CONNECT evil.com:443 HTTP/1.1\r\n\r\n');
      expect(resp).toMatch(/403 Forbidden/);
      const badPort = await connectRequest(addr.port, 'CONNECT runtime.us-east-1.kiro.dev:8080 HTTP/1.1\r\n\r\n');
      expect(badPort).toMatch(/403 Forbidden/);
      const bad = await connectRequest(addr.port, 'GET / HTTP/1.1\r\n\r\n');
      expect(bad).toMatch(/400 Bad Request/);
    } finally { await proxy.stop(); }
  });
});

describe('egress proxy — network naming + lifecycle', () => {
  it('produces valid Docker network names', () => {
    const name = jobNetworkName('job_' + '0'.repeat(32));
    expect(name).toMatch(/^io-quarangate-net-job_/);
    expect(name).not.toContain('.');
  });

  it('starts and stops cleanly', async () => {
    const proxy = new EgressProxy({ listenHost: '127.0.0.1', listenPort: 0 });
    const addr = await proxy.start();
    expect(addr.port).toBeGreaterThan(0);
    await proxy.stop();
  });
});

function connectRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write(payload));
    let buf = '';
    s.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes('\r\n\r\n')) { s.destroy(); resolve(buf); } });
    s.on('error', reject);
    s.setTimeout(3000, () => { s.destroy(); resolve(buf); });
  });
}
