import http from 'node:http';
import express from 'express';
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
    const [appJs, clientJs, css] = await Promise.all([
      fetch(`${base}/console/app.js`),
      fetch(`${base}/console/mcp-client.js`),
      fetch(`${base}/console/styles.css`),
    ]);
    expect(appJs.status).toBe(200);
    expect(clientJs.status).toBe(200);
    expect(css.status).toBe(200);
    expect(await appJs.text()).toContain("agent_dispatch");
    expect(await clientJs.text()).toContain("tools/call");
    expect(await css.text()).toContain('--qg-primary');
  });

  it('does not turn unknown console assets into an application success response', async () => {
    const base = await startConsole();
    const response = await fetch(`${base}/console/does-not-exist.js`);
    expect(response.status).toBe(404);
  });
});
