import http from 'node:http';
import net from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GatewayRequestAdmissionError,
  buildGatewayRequestPolicy,
  gatewayRequestAdmission,
  parseRequestAuthority,
} from '../../src/gateway/requestAdmission.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function request(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2', ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}


function rawRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('connect', () => socket.end(requestText));
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

async function server(policy = buildGatewayRequestPolicy('https://wolf.example.test', 8787)): Promise<number> {
  const app = express();
  app.use(gatewayRequestAdmission(policy));
  app.post('/mcp', express.json(), (_req, res) => res.json({ ok: true }));
  const srv = http.createServer(app);
  servers.push(srv);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const address = srv.address();
  if (!address || typeof address === 'string') throw new Error('test listener unavailable');
  return address.port;
}

describe('SH-01 gateway Host/Origin admission', () => {
  it('accepts exact public Host with no Origin for server-side MCP clients', async () => {
    const port = await server();
    expect(await request(port, { host: 'wolf.example.test' })).toMatchObject({ status: 200 });
    expect(await request(port, { host: 'wolf.example.test:443' })).toMatchObject({ status: 200 });
  });

  it('accepts same-origin public browser requests and rejects cross-origin browsers', async () => {
    const port = await server();
    expect(await request(port, { host: 'wolf.example.test', origin: 'https://wolf.example.test' })).toMatchObject({ status: 200 });
    const denied = await request(port, { host: 'wolf.example.test', origin: 'https://evil.example' });
    expect(denied.status).toBe(403);
    expect(denied.body).not.toContain('wolf.example.test');
  });

  it('rejects duplicate raw Host headers before Node normalization can influence policy', async () => {
    const port = await server();
    const response = await rawRequest(port,
      'POST /mcp HTTP/1.1\r\nHost: wolf.example.test\r\nHost: attacker.example\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
    // Node may reject the duplicate at its parser or pass it to our middleware;
    // either outcome must be non-success and never reach the MCP route.
    expect(response).not.toMatch(/^HTTP\/1\.1 200 /u);
  });

  it('blocks DNS rebinding even when a forwarded Host claims the approved public origin', async () => {
    const port = await server();
    const denied = await request(port, {
      host: 'attacker.example:8787',
      'x-forwarded-host': 'wolf.example.test',
      origin: 'https://attacker.example:8787',
    });
    expect(denied.status).toBe(421);
    expect(denied.body).not.toContain('attacker.example');
  });

  it('allows the pinned public Origin when an approved reverse proxy rewrites Host to loopback', async () => {
    const port = await server();
    expect(await request(port, {
      host: '127.0.0.1:8787',
      origin: 'https://wolf.example.test',
      'x-forwarded-host': 'attacker-controlled.example',
    })).toMatchObject({ status: 200 });
  });

  it('allows exact local operational Host/Origin pairs only on the configured gateway port', async () => {
    const port = await server();
    expect(await request(port, { host: '127.0.0.1:8787' })).toMatchObject({ status: 200 });
    expect(await request(port, { host: 'localhost:8787', origin: 'http://localhost:8787' })).toMatchObject({ status: 200 });
    expect((await request(port, { host: 'localhost:8788' })).status).toBe(421);
    expect((await request(port, { host: 'localhost:8787', origin: 'http://127.0.0.1:8787' })).status).toBe(403);
  });

  it('rejects malformed, missing-equivalent, dotted and smuggled authorities', () => {
    for (const value of ['evil.example.', 'evil.example,good.example', 'user@evil.example', 'evil.example/path', 'evil.example:00080', '[2001:db8::1]:8787']) {
      expect(() => parseRequestAuthority(value)).toThrow(GatewayRequestAdmissionError);
    }
  });

  it('requires origin-only public config and HTTPS away from loopback', () => {
    expect(() => buildGatewayRequestPolicy('http://bridge.example.test', 8787)).toThrow(/HTTPS/u);
    expect(() => buildGatewayRequestPolicy('https://bridge.example.test/mcp', 8787)).toThrow(/origin only/u);
    expect(() => buildGatewayRequestPolicy('https://user@bridge.example.test', 8787)).toThrow(/origin only/u);
    expect(() => buildGatewayRequestPolicy('http://127.0.0.1:8787', 0)).toThrow(/BRIDGE_PORT/u);
    expect(buildGatewayRequestPolicy('http://127.0.0.1:8787', 8787).publicOrigin).toBe('http://127.0.0.1:8787');
  });

  it('does not authorize a Host solely because an Origin is approved', async () => {
    const port = await server();
    expect((await request(port, { host: 'evil.example', origin: 'https://wolf.example.test' })).status).toBe(421);
  });
});
