import { readFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EgressProxy,
  isPrivateAddress,
  parseEgressProxyEnvironment,
  resolveAndValidate,
  validateConnectTarget,
} from '../../src/executor/agents/egressProxy.js';
import { parseCopilotEgressHosts } from '../../src/executor/copilotConfig.js';
import { normalizeExactEgressHostname } from '../../src/shared/egressPolicy.js';

const root = resolve(import.meta.dirname, '../..');

function connectRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(payload));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        socket.destroy();
        resolvePromise(buffer);
      }
    });
    socket.on('error', reject);
    socket.setTimeout(3000, () => { socket.destroy(); resolvePromise(buffer); });
  });
}

describe('SH-10 exact egress hostname policy', () => {
  it('accepts normalized multi-label ASCII hostnames and rejects ambiguous/alternate authority forms', () => {
    expect(normalizeExactEgressHostname('API.GITHUB.COM')).toBe('api.github.com');
    for (const bad of [
      'localhost', '127.0.0.1', '2130706433', 'example.com.', '.example.com',
      'a..example.com', 'a.-b.example.com', 'a.b-.example.com', 'user@example.com',
      'example.com:443', ' example.com', 'example.com ', '例子.example.com',
      `${'a'.repeat(64)}.example.com`,
    ]) {
      expect(() => normalizeExactEgressHostname(bad), bad).toThrow();
    }
  });

  it('normalizes and de-duplicates Copilot exact egress hosts through the shared policy', () => {
    expect(parseCopilotEgressHosts('API.GITHUBCOPILOT.COM,api.githubcopilot.com')).toEqual(['api.githubcopilot.com']);
    for (const bad of ['127.0.0.1', 'localhost', 'a.-b.example.com', 'example.com.', '例子.example.com']) {
      expect(() => parseCopilotEgressHosts(bad), bad).toThrow(/invalid exact hostname/u);
    }
  });

  it('never interprets an explicit empty replacement allowlist as the Kiro default allowlist', async () => {
    expect(() => parseEgressProxyEnvironment({ EGRESS_PROXY_EXACT_ALLOWLIST: '' }))
      .toThrow(/contains no valid hosts/u);
    const proxy = new EgressProxy({ listenHost: '127.0.0.1', listenPort: 0, allowedHosts: [] });
    const addr = await proxy.start();
    try {
      const response = await connectRequest(addr.port, 'CONNECT runtime.us-east-1.kiro.dev:443 HTTP/1.1\r\n\r\n');
      expect(response).toMatch(/403 Forbidden/u);
      expect(response).toMatch(/not in the egress allowlist/u);
    } finally { await proxy.stop(); }
  });

  it('fails closed on ambiguous exact/additive configuration, invalid hosts and invalid ports', () => {
    expect(() => parseEgressProxyEnvironment({
      EGRESS_PROXY_EXACT_ALLOWLIST: 'api.github.com',
      EGRESS_PROXY_ALLOWLIST: 'github.com',
    })).toThrow(/cannot be combined/u);
    for (const port of ['0', '65536', '-1', '443.0', 'abc']) {
      expect(() => parseEgressProxyEnvironment({ EGRESS_PROXY_PORT: port }), port).toThrow(/1\.\.65535/u);
    }
    expect(() => parseEgressProxyEnvironment({ EGRESS_PROXY_EXACT_ALLOWLIST: 'api.github.com,a.-b.example.com' }))
      .toThrow();
    expect(parseEgressProxyEnvironment({
      EGRESS_PROXY_PORT: '8080',
      EGRESS_PROXY_EXACT_ALLOWLIST: 'API.GITHUB.COM,github.com,api.github.com',
    })).toEqual({
      listenHost: '0.0.0.0', listenPort: 8080, allowedHosts: ['api.github.com', 'github.com'],
    });
  });
});

describe('SH-10 non-global address rejection', () => {
  it('blocks private, metadata, multicast, reserved, documentation and transition address ranges', () => {
    const blocked = [
      '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1',
      '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.250',
      '240.0.0.1', '255.255.255.255',
      '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
      '64:ff9b::7f00:1', '64:ff9b:1::7f00:1', '100::1', '2001::1', '2001:2::1',
      '2001:db8::1', '2002:7f00:1::', '3fff::1', 'fc00::1', 'fd12::1', 'fe80::1',
      'fec0::1', 'ff02::1',
    ];
    for (const address of blocked) expect(isPrivateAddress(address), address).toBe(true);
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });

  it('allows representative globally routable IPv4 and IPv6 addresses', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '52.94.236.100', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('validates every DNS answer, rejects malformed resolver data and returns a pinned public address', async () => {
    await expect(resolveAndValidate('api.example.com', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])).rejects.toThrow(/non-global address/u);
    await expect(resolveAndValidate('api.example.com', async () => [
      { address: '8.8.8.8', family: 6 },
    ])).rejects.toThrow(/malformed DNS address data/u);
    await expect(resolveAndValidate('api.example.com', async () => [
      { address: 'not-an-ip', family: 4 },
    ])).rejects.toThrow(/malformed DNS address data/u);
    await expect(resolveAndValidate('api.example.com', async () => [])).rejects.toThrow(/no addresses/u);
    await expect(resolveAndValidate('api.example.com', () => new Promise(() => {}), 10)).rejects.toThrow(/timed out/u);
    await expect(resolveAndValidate('api.example.com', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ])).resolves.toBe('8.8.8.8');
  });
});

describe('SH-10 CONNECT admission and network composition', () => {
  it('keeps exact host/443-only admission and rejects malformed hostname variants', () => {
    const allow = ['api.github.com'];
    expect(validateConnectTarget('API.GITHUB.COM', 443, allow)).toBeNull();
    for (const bad of ['api.github.com.', 'api..github.com', 'a.-github.com', 'api.github.com\0']) {
      expect(validateConnectTarget(bad, 443, allow), bad).toMatch(/malformed|not in/u);
    }
    expect(validateConnectTarget('api.github.com', 80, allow)).toMatch(/only 443/u);
  });

  it('counts the terminating CRLFCRLF inside the exact CONNECT header byte cap', async () => {
    const proxy = new EgressProxy({ listenHost: '127.0.0.1', listenPort: 0 });
    const addr = await proxy.start();
    try {
      const prefix = 'CONNECT runtime.us-east-1.kiro.dev:443 HTTP/1.1\r\nX-Fill: ';
      const targetHeaderEnd = 8190; // old check allowed this; +4 terminator exceeds the 8192-byte cap.
      const fill = 'x'.repeat(targetHeaderEnd - Buffer.byteLength(prefix, 'utf8'));
      const payload = `${prefix}${fill}\r\n\r\n`;
      expect(Buffer.byteLength(payload, 'utf8')).toBe(8194);
      const response = await connectRequest(addr.port, payload);
      expect(response).toMatch(/400 Request Too Large/u);
    } finally { await proxy.stop(); }
  });

  it('rejects oversized CONNECT headers before target dialing', async () => {
    const proxy = new EgressProxy({ listenHost: '127.0.0.1', listenPort: 0 });
    const addr = await proxy.start();
    try {
      const response = await connectRequest(
        addr.port,
        `CONNECT runtime.us-east-1.kiro.dev:443 HTTP/1.1\r\nX-Fill: ${'x'.repeat(9000)}\r\n\r\n`,
      );
      expect(response).toMatch(/400 Request Too Large/u);
    } finally { await proxy.stop(); }
  });

  it('keeps runners on internal-only networks and connects external networks only to proxy containers', () => {
    const kiro = readFileSync(`${root}/src/executor/agents/kiroBackend.ts`, 'utf8');
    const copilot = readFileSync(`${root}/src/executor/agents/copilotBackend.ts`, 'utf8');
    for (const source of [kiro, copilot]) {
      expect(source).toContain('internal: true');
      expect(source).toContain('internal: false');
      expect(source).toContain("'NO_PROXY='");
      expect(source).toContain('HTTPS_PROXY=');
      expect(source).toContain('ALL_PROXY=');
    }
    expect(kiro).toContain('await connectNetwork(this.extNet, this.proxyContainerId);');
    expect(kiro).not.toContain('await connectNetwork(this.extNet, this.runnerContainerId);');
    expect(copilot).toContain('await connectNetwork(this.externalNetwork, this.proxyContainerId);');
    expect(copilot).not.toContain('await connectNetwork(this.externalNetwork, this.runnerContainerId);');
  });

  it('keeps GitHub broker egress fixed to the exact internal proxy and fixed GitHub API origin', () => {
    const broker = readFileSync(`${root}/src/github-broker/index.ts`, 'utf8');
    expect(broker).toContain("const API = 'https://api.github.com';");
    expect(broker).toContain("proxy.hostname !== 'github-egress-proxy'");
    expect(broker).toContain("proxy.port !== '8080'");
    expect(broker).not.toMatch(/rawGitHub\([^)]*url/u);
  });
});
