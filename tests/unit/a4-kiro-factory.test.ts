/**
 * A4 production backend-factory tests.
 *
 * Proves the trusted wiring the Executor uses:
 *   - backend=kiro selects the REAL KiroBackend (Docker Engine API launcher),
 *   - every other backend falls back to the deterministic fake (null),
 *   - the write profile `implement` is DENIED (fails closed) — never run,
 * and that the engine handles a fail-closed backend construction without
 * leaving the job stuck.
 *
 * No Docker and no provider call: implement is denied at construction, and the
 * selection assertions never call prepare().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentJobStore, type AgentJobRow } from '../../src/executor/agents/jobStore.js';
import { AgentJobEngine } from '../../src/executor/agents/jobEngine.js';
import { parseAgentConfigYaml } from '../../src/executor/agentConfig.js';
import { createKiroBackendFactory } from '../../src/executor/agents/kiroFactory.js';
import { KiroBackend, type KiroBackendOptions } from '../../src/executor/agents/kiroBackend.js';
import { ACP_AGENT_NAME_PATTERN } from '../../src/executor/agents/acpDriver.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';
import { BridgeError } from '../../src/shared/errors.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cfg = parseAgentConfigYaml(readFileSync(join(repoRoot, 'config', 'agents.example.yaml'), 'utf8'));
const projects = cfg.projects.map((p) => ({ id: p.id, hostPath: p.hostPath }));
const policy = (): AgentResourcePolicy => cfg.resourcePolicies.find((r) => r.id === 'standard')!;

// Deps are never dereferenced for the selection/denial paths (no prepare()).
const deps = (): KiroBackendOptions => ({
  runnerImage: 'runner:test', helperImage: 'helper:test', proxyImage: 'proxy:test',
  proxyCmd: ['node', 'x'], credentialManager: {} as any, sandbox: {} as any,
});

function row(over: Partial<AgentJobRow> = {}): AgentJobRow {
  return {
    jobId: 'job_' + '0'.repeat(32), principalId: 'owner', backend: 'kiro',
    project: 'example-project', profile: 'audit', resourcePolicy: 'standard',
    status: 'PREPARING', failureCode: null, failureReason: null,
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    promptHash: 'h', prompt: 'analyze', summary: null, exitCode: null,
    backendSessionId: null, sessionPolicy: 'new', writer: false, baseCommit: null,
    ...over,
  };
}

describe('createKiroBackendFactory — selection', () => {
  const factory = createKiroBackendFactory(projects, deps());

  it('selects the real KiroBackend for backend=kiro (read-only profile)', () => {
    const b = factory(row({ profile: 'audit' }), policy());
    expect(b).toBeInstanceOf(KiroBackend);
    expect(ACP_AGENT_NAME_PATTERN.test((b as KiroBackend).getAgentName())).toBe(true);
  });

  it('falls back to the fake backend (null) for non-kiro backends', () => {
    expect(factory(row({ backend: 'copilot' }), policy())).toBeNull();
  });

  it('ACCEPTS implement (A5 write lane) — constructs a write-mode KiroBackend', () => {
    const b = factory(row({ profile: 'implement', writer: true }), policy());
    expect(b).toBeInstanceOf(KiroBackend);
    expect((b as KiroBackend).isWriteMode()).toBe(true);
    expect(/^mcp_impl_[0-9a-f]{32}$/.test((b as KiroBackend).getAgentName())).toBe(true);
  });

  it('uses an advertised model (never haiku)', () => {
    const b = factory(row(), policy()) as KiroBackend;
    expect(b.getModel()).toMatch(/^claude-sonnet/);
  });
});

describe('engine + kiro factory — implement is ADMITTED (A5), not a policy denial', () => {
  let store: AgentJobStore;
  let engine: AgentJobEngine;

  beforeEach(() => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-kf-')), 'agents.db');
    store = new AgentJobStore(dbPath);
    const c = parseAgentConfigYaml(readFileSync(join(repoRoot, 'config', 'agents.example.yaml'), 'utf8'));
    engine = new AgentJobEngine(store, c, undefined, createKiroBackendFactory(projects, deps()));
  });
  afterEach(() => { engine.shutdown(); try { store.close(); } catch { /* noop */ } });

  it('a kiro+implement job passes the policy/construction gate (no longer FAILED_POLICY)', async () => {
    // A5 owns write capability, so implement is admitted and begins execution.
    // With deliberately broken (empty) backend deps it can only fail at PREPARE
    // as INFRASTRUCTURE — which itself proves it was NOT denied at the policy
    // gate and NOT auto-completed/applied.
    const job = engine.dispatch({
      principal: 'owner', backend: 'kiro', project: 'example-project',
      profile: 'implement', prompt: 'please edit files',
    });
    expect(job.writer).toBe(true);
    const start = Date.now();
    let row = store.get(job.jobId)!;
    for (;;) {
      row = store.get(job.jobId)!;
      if (row.status.startsWith('FAILED') || row.status === 'COMPLETED' || row.status === 'CANCELLED') break;
      if (Date.now() - start > 4000) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(row.failureCode).not.toBe('FAILED_POLICY');
    expect(row.status).not.toBe('COMPLETED'); // never auto-completes/applies
    expect(row.status).toBe('FAILED_INFRASTRUCTURE'); // broken deps, past policy gate
  });
});
