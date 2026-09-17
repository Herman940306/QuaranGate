import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentJobEngine, type AgentBackendAdapter } from '../../src/executor/agents/jobEngine.js';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { OllamaBackend } from '../../src/executor/agents/ollamaBackend.js';
import { validateAgentConfig } from '../../src/executor/agentConfig.js';
import type { Principal } from '../../src/gateway/config.js';


function constructibleOllamaMock(instance: Record<string, unknown>): typeof import('ollama').Ollama {
  return vi.fn(class {
    constructor() { Object.assign(this, instance); }
  }) as unknown as typeof import('ollama').Ollama;
}

const PRINCIPAL: Principal = {
  id: 'owner', name: 'Owner', keyHash: 'a'.repeat(64), enabled: true,
  scopes: ['agents:read'], targets: [], projects: ['proj1'], agentBackends: ['ollama'], agentProfiles: ['audit'],
};

const CONFIG = validateAgentConfig({
  backends: [{ id: 'ollama', enabled: true, profiles: ['audit'], defaultResourcePolicy: 'economy' }],
  projects: [{ id: 'proj1', hostPath: '/srv/proj1', worktreeId: 'proj1', gitRequired: true, backends: ['ollama'], profiles: ['audit'], guardedPaths: [], sensitiveReadGlobs: [] }],
  profiles: [{ id: 'audit', workspaceAccess: 'read-only', shellPolicy: 'read-only', gitPolicy: 'read', networkPolicy: 'backend-only', defaultResourcePolicy: 'economy' }],
  resourcePolicies: [{
    id: 'economy', modelClass: 'fast', maxRuntimeMs: 10_000, maxCpuMillicores: 1000,
    maxMemoryBytes: 256 * 1024 * 1024, maxPids: 64, maxOutputBytes: 65_536,
    maxEvidenceBytes: 1_048_576, networkPolicy: 'deny', retentionClass: 'ephemeral',
  }],
});

let server: http.Server;
let terminalJob: Record<string, unknown> | null = null;
let resultHandler: (args: unknown) => Promise<{
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;
let withPrincipal: <T>(principal: Principal, fn: () => T) => T;
const tempDirs: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || !/^\/agent\/jobs\/job_[0-9a-f]{32}\/result$/u.test(url.pathname) || url.searchParams.get('principal') !== 'owner' || !terminalJob) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'INTERNAL', message: 'unexpected test route' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ job: terminalJob }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind SH-12 agent_result test server');

  process.env.INTERNAL_TOKEN = 'sh12-ollama-diagnostic-test-token';
  process.env.EXECUTOR_URL = `http://127.0.0.1:${address.port}`;
  vi.resetModules();
  const [agentTools, context] = await Promise.all([
    import('../../src/gateway/agentTools.js'),
    import('../../src/gateway/context.js'),
  ]);
  withPrincipal = context.withPrincipal;
  const captured: Array<{ name: string; handler: typeof resultHandler }> = [];
  agentTools.registerAgentTools({
    registerTool(name: string, _cfg: unknown, handler: typeof resultHandler) {
      captured.push({ name, handler });
    },
  } as never);
  const found = captured.find((tool) => tool.name === 'agent_result');
  if (!found) throw new Error('agent_result was not registered');
  resultHandler = found.handler;
});

afterEach(() => {
  terminalJob = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.INTERNAL_TOKEN;
  delete process.env.EXECUTOR_URL;
});

function backendFactoryFor(kind: 'request' | 'stream', marker: string) {
  return (job: any, policy: any): AgentBackendAdapter => {
    const rawProviderError = new Error(`${kind} provider diagnostic ${marker} prompt=TOP_SECRET`);
    const chat = kind === 'request'
      ? vi.fn().mockRejectedValue(rawProviderError)
      : vi.fn().mockResolvedValue((async function* () {
          throw rawProviderError;
        })());
    const MockOllama = constructibleOllamaMock({ chat, abort: vi.fn() });
    const backend = new OllamaBackend(
      {
        jobId: job.jobId, principalId: job.principalId, backend: 'ollama', project: job.project,
        profile: job.profile, prompt: 'bounded SH-12 regression', hostPath: '/srv/proj1', policy,
      },
      {
        ollamaHost: 'http://ollama:11434', modelQualifier: 'm:v1', helperImage: 'helper:v1',
        sandbox: {} as any, sensitiveReadGlobs: [], OllamaClass: MockOllama,
      },
    );
    (backend as unknown as Record<string, unknown>)['target'] = { containerId: 'fake', workspace: '/workspace' };
    return {
      async prepare() {},
      run: (signal) => backend.run(signal),
      validate: (signal) => backend.validate(signal),
      isAgentFailure: (error) => backend.isAgentFailure(error),
      isDryRun: () => backend.isDryRun(),
    };
  };
}

async function proveSanitizedDurableAndPublicFailure(kind: 'request' | 'stream'): Promise<void> {
  const marker = `HOSTILE_OLLAMA_${kind.toUpperCase()}_DIAGNOSTIC_SENTINEL`;
  const dir = mkdtempSync(join(tmpdir(), `qg-sh12-ollama-${kind}-`));
  tempDirs.push(dir);
  const store = new AgentJobStore(join(dir, 'agents.db'));
  const engine = new AgentJobEngine(
    store,
    CONFIG,
    () => ({}),
    backendFactoryFor(kind, marker),
    undefined,
    undefined,
    undefined,
    new Set(['ollama']),
  );
  try {
    const queued = engine.dispatch({ principal: 'owner', backend: 'ollama', project: 'proj1', profile: 'audit', prompt: 'run provider failure regression' });
    const deadline = Date.now() + 3000;
    let done = store.get(queued.jobId)!;
    while (!['FAILED_AGENT', 'FAILED_INFRASTRUCTURE', 'FAILED_TIMEOUT', 'FAILED_POLICY', 'FAILED_PRECONDITION', 'CANCELLED'].includes(done.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      done = store.get(queued.jobId)!;
    }

    expect(done.status).toBe('FAILED_AGENT');
    expect(done.failureCode).toBe('FAILED_AGENT');
    expect(done.failureReason).toBe(`ollama provider ${kind} failed`);
    expect(JSON.stringify(done)).not.toContain(marker);
    expect(JSON.stringify(done)).not.toContain('TOP_SECRET');

    terminalJob = done as unknown as Record<string, unknown>;
    const publicResult = await withPrincipal(PRINCIPAL, () => resultHandler({ jobId: done.jobId }));
    expect(publicResult.isError).not.toBe(true);
    expect(publicResult.structuredContent?.status).toBe('FAILED_AGENT');
    expect(publicResult.structuredContent?.summary).toBe(`Job FAILED_AGENT: ollama provider ${kind} failed`);
    expect(JSON.stringify(publicResult)).not.toContain(marker);
    expect(JSON.stringify(publicResult)).not.toContain('TOP_SECRET');
  } finally {
    engine.shutdown();
    store.close();
  }
}

describe('SH-12 R1 Ollama provider diagnostic normalization', () => {
  it('normalizes a rejected Ollama chat() diagnostic before durable failure and public agent_result', async () => {
    await proveSanitizedDurableAndPublicFailure('request');
  });

  it('normalizes a streaming Ollama diagnostic before durable failure and public agent_result', async () => {
    await proveSanitizedDurableAndPublicFailure('stream');
  });
});
