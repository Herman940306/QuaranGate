import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_PROVIDER_RETRY_AFTER_MS } from '../../src/shared/agents.js';
import type { Principal } from '../../src/gateway/config.js';

const TEST_TOKEN = 'retry-after-wiring-token';
const PRINCIPAL: Principal = {
  id: 'retry-after-client',
  name: 'Retry After Test Client',
  keyHash: 'a'.repeat(64),
  scopes: ['agents:dispatch'],
  targets: [],
  enabled: true,
  projects: ['proj1'],
  agentBackends: ['kiro'],
  agentProfiles: ['audit'],
};

let server: http.Server;
let retryAfterValue: unknown = 7000;
let dispatchHandler: (args: unknown) => Promise<{
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;
let withPrincipal: <T>(principal: Principal, fn: () => T) => T;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/agent/jobs') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL', message: 'unexpected test route' }));
        return;
      }
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'RATE_LIMITED',
        message: 'backend cooling down',
        retryAfterMs: retryAfterValue,
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind retry-after test server');

  process.env.INTERNAL_TOKEN = TEST_TOKEN;
  process.env.EXECUTOR_URL = `http://127.0.0.1:${address.port}`;
  vi.resetModules();

  const [agentTools, context] = await Promise.all([
    import('../../src/gateway/agentTools.js'),
    import('../../src/gateway/context.js'),
  ]);
  withPrincipal = context.withPrincipal;

  const captured: { name: string; handler: typeof dispatchHandler }[] = [];
  const fakeServer = {
    registerTool(name: string, _cfg: unknown, handler: typeof dispatchHandler) {
      captured.push({ name, handler });
    },
  };
  agentTools.registerAgentTools(fakeServer as never);
  const found = captured.find((tool) => tool.name === 'agent_dispatch');
  if (!found) throw new Error('agent_dispatch was not registered');
  dispatchHandler = found.handler;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.INTERNAL_TOKEN;
  delete process.env.EXECUTOR_URL;
});

async function dispatchAndParse(): Promise<Record<string, unknown>> {
  const result = await withPrincipal(PRINCIPAL, () => dispatchHandler({
    backend: 'kiro',
    project: 'proj1',
    profile: 'audit',
    prompt: 'bounded retry propagation test',
  }));
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('P3 provider retry guidance — executor to MCP gateway propagation', () => {
  it('preserves a valid bounded executor retryAfterMs through the agent tool error', async () => {
    retryAfterValue = 7000;
    await expect(dispatchAndParse()).resolves.toEqual({
      error: 'RATE_LIMITED',
      message: 'backend cooling down',
      retryAfterMs: 7000,
    });
  });

  it('clamps an oversized executor retryAfterMs to the frozen provider maximum', async () => {
    retryAfterValue = 99_999_999;
    await expect(dispatchAndParse()).resolves.toEqual({
      error: 'RATE_LIMITED',
      message: 'backend cooling down',
      retryAfterMs: MAX_PROVIDER_RETRY_AFTER_MS,
    });
  });

  it.each([[-1], [0], ['7000'], [null]])('omits malformed retry guidance: %j', async (value) => {
    retryAfterValue = value;
    await expect(dispatchAndParse()).resolves.toEqual({
      error: 'RATE_LIMITED',
      message: 'backend cooling down',
    });
  });
});
