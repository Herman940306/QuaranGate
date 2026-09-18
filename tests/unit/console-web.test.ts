import http from 'node:http';
import express from 'express';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { mountConsoleWeb } from '../../src/gateway/consoleWeb.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startConsole(): Promise<string> {
  const app = express();
  app.disable('x-powered-by');
  mountConsoleWeb(app);
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

describe('QuaranGate Console web facade', () => {
  it('serves the console only under the additive /console route with security headers', async () => {
    const base = await startConsole();
    const response = await fetch(`${base}/console/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.text()).toContain('QuaranGate');
  });

  it('serves browser modules and styles from the same origin', async () => {
    const base = await startConsole();
    const [appJs, clientJs, css, catalog] = await Promise.all([
      fetch(`${base}/console/app.js`),
      fetch(`${base}/console/mcp-client.js`),
      fetch(`${base}/console/styles.css`),
      fetch(`${base}/console/tool-catalog.js`),
    ]);
    expect(appJs.status).toBe(200);
    expect(clientJs.status).toBe(200);
    expect(css.status).toBe(200);
    expect(catalog.status).toBe(200);
    expect(await appJs.text()).toContain("agent_dispatch");
    expect(await clientJs.text()).toContain("tools/call");
    expect(await css.text()).toContain('--qg-primary');
    expect(await catalog.text()).toContain('TOOL_CATALOG');
  });

  it('does not turn unknown console assets into an application success response', async () => {
    const base = await startConsole();
    const response = await fetch(`${base}/console/does-not-exist.js`);
    expect(response.status).toBe(404);
  });


  it('keeps the gateway startup on one listener while registering Console on the existing app', () => {
    const gateway = readFileSync(new URL('../../src/gateway/index.ts', import.meta.url), 'utf8');
    const admission = gateway.indexOf('app.use(gatewayRequestAdmission(REQUEST_POLICY));');
    const telemetry = gateway.indexOf('mountRequestTelemetry(app);');
    const consoleMount = gateway.indexOf('mountConsoleWeb(app);');
    const health = gateway.indexOf("app.get('/healthz'");
    const mcpPost = gateway.indexOf("app.post('/mcp'");
    const listen = gateway.indexOf("app.listen(PORT, '0.0.0.0'");

    expect(gateway).toContain("import { mountConsoleWeb } from './consoleWeb.js';");
    expect(admission).toBeGreaterThanOrEqual(0);
    expect(telemetry).toBeGreaterThan(admission);
    expect(consoleMount).toBeGreaterThan(telemetry);
    expect(health).toBeGreaterThan(consoleMount);
    expect(mcpPost).toBeGreaterThan(health);
    expect(listen).toBeGreaterThan(mcpPost);
    expect(gateway.match(/\.listen\(/g)).toHaveLength(1);
    expect(gateway).toContain("app.get('/mcp'");
    expect(gateway).toContain("app.delete('/mcp'");
  });

  it('redirects the bare Console route canonically and leaves unrelated routes at 404', async () => {
    const base = await startConsole();
    const bare = await fetch(`${base}/console`, { redirect: 'manual' });
    expect([301, 302, 307, 308]).toContain(bare.status);
    expect(bare.headers.get('location')).toBe('/console/');

    const unrelated = await fetch(`${base}/does-not-exist`);
    expect(unrelated.status).toBe(404);
  });
});
