import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mountRequestTelemetry,
  requestTelemetryId,
  setRequestTelemetryOutcome,
  type RequestTelemetryEvent,
} from '../../src/gateway/requestTelemetry.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startTelemetryServer(events: RequestTelemetryEvent[]): Promise<string> {
  const app = express();
  mountRequestTelemetry(app, (event) => events.push(event));
  app.post('/mcp', express.json(), (_req, res) => {
    res.status(401).json({ ok: false, requestIdPresent: Boolean(requestTelemetryId(res)) });
  });
  app.post('/oauth/token', express.urlencoded({ extended: false }), (_req, res) => {
    setRequestTelemetryOutcome(res, 'oauth_refresh_token_missing');
    res.status(400).json({ error: 'invalid_grant' });
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

describe('gateway request telemetry', () => {
  it('records MCP arrival/completion metadata with one server request ID and no sensitive input', async () => {
    const events: RequestTelemetryEvent[] = [];
    const base = await startTelemetryServer(events);
    const secret = 'SENSITIVE_VALUE_MUST_NOT_APPEAR';
    const response = await fetch(`${base}/mcp?token=${secret}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        cookie: `session=${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ argument: secret }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('x-quarangate-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toEqual({ ok: false, requestIdPresent: true });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.event)).toEqual(['http_request_start', 'http_request_complete']);
    expect(events[0]!.requestId).toBe(events[1]!.requestId);
    expect(events[0]!.connectionId).toBe(events[1]!.connectionId);
    expect(events[0]).toMatchObject({ method: 'POST', path: '/mcp', httpVersion: '1.1' });
    expect(events[1]).toMatchObject({ status: 401 });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain('authorization');
    expect(JSON.stringify(events)).not.toContain('cookie');
    expect(JSON.stringify(events)).not.toContain('argument');
    expect(JSON.stringify(events)).not.toContain('token=');
  });

  it('records OAuth token 400 responses without recording form values', async () => {
    const events: RequestTelemetryEvent[] = [];
    const base = await startTelemetryServer(events);
    const secret = 'REFRESH_TOKEN_MUST_NOT_APPEAR';
    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: secret }),
    });

    expect(response.status).toBe(400);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'http_request_start', path: '/oauth/token' });
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

  it('does not log health or attacker-controlled unknown paths', async () => {
    const events: RequestTelemetryEvent[] = [];
    const base = await startTelemetryServer(events);
    const secret = 'UNKNOWN_PATH_SECRET';
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/${secret}`)).status).toBe(404);
    expect(events).toEqual([]);
  });
});
