import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestTelemetryEvent } from '../../src/gateway/requestTelemetry.js';

const servers: http.Server[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete process.env.DATA_DIR;
});

describe('OAuth request telemetry integration', () => {
  it('records fixed failure categories without OAuth request values', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qg-oauth-telemetry-'));
    tempDirectories.push(directory);
    process.env.DATA_DIR = directory;
    vi.resetModules();
    const [{ mountOAuth }, { mountRequestTelemetry }] = await Promise.all([
      import('../../src/gateway/auth/oauth.js'),
      import('../../src/gateway/requestTelemetry.js'),
    ]);

    const events: RequestTelemetryEvent[] = [];
    const app = express();
    mountRequestTelemetry(app, (event) => events.push(event));
    mountOAuth(app, 'https://wolf.taildc680e.ts.net');
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
    const base = `http://127.0.0.1:${address.port}`;

    const secret = 'OAUTH_VALUE_MUST_NOT_APPEAR';
    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: secret,
        refresh_token: secret,
        resource: 'https://wolf.taildc680e.ts.net/mcp',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      event: 'http_request_complete',
      path: '/oauth/token',
      status: 400,
      outcome: 'oauth_refresh_token_missing',
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events[1]).not.toHaveProperty('body');
    expect(events[1]).not.toHaveProperty('headers');
    expect(events[1]).not.toHaveProperty('query');
  });

  it('classifies duplicate refresh-token redemption as a missing/replayed credential', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qg-oauth-telemetry-'));
    tempDirectories.push(directory);
    process.env.DATA_DIR = directory;
    const refresh = 'SYNTHETIC_REFRESH_MUST_NOT_APPEAR';
    const refreshHash = createHash('sha256').update(refresh).digest('hex');
    writeFileSync(path.join(directory, 'oauth-tokens.json'), JSON.stringify({
      [refreshHash]: {
        principalId: 'synthetic-principal',
        clientId: 'synthetic-client',
        resource: 'https://wolf.taildc680e.ts.net/mcp',
        expiresAt: Date.now() + 60_000,
        refresh: true,
      },
    }), { mode: 0o600 });

    vi.resetModules();
    const [{ mountOAuth }, { mountRequestTelemetry }] = await Promise.all([
      import('../../src/gateway/auth/oauth.js'),
      import('../../src/gateway/requestTelemetry.js'),
    ]);
    const events: RequestTelemetryEvent[] = [];
    const app = express();
    mountRequestTelemetry(app, (event) => events.push(event));
    mountOAuth(app, 'https://wolf.taildc680e.ts.net');
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
    const tokenUrl = `http://127.0.0.1:${address.port}/oauth/token`;
    const redeem = () => fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'synthetic-client',
        refresh_token: refresh,
        resource: 'https://wolf.taildc680e.ts.net/mcp',
      }),
    });

    const responses = await Promise.all([redeem(), redeem()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(events.filter((event) => event.event === 'http_request_complete' && event.status === 400))
      .toEqual([expect.objectContaining({ outcome: 'oauth_refresh_token_missing' })]);
    expect(JSON.stringify(events)).not.toContain(refresh);
  });
});
