import { describe, it, expect, afterAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, callTool, loadKeys } from './helpers.js';
import { composeServiceContainerId, dockerContainerHealth, integrationRuntimeControl, restartComposeService } from './runtime-control.js';

const keys = loadKeys();
const runtime = integrationRuntimeControl();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function status(c: Client, jobId: string) {
  const r = await callTool(c, 'agent_status', { jobId });
  return r.json?.status as string | undefined;
}

async function kiroAvailable(c: Client): Promise<boolean> {
  const res = await callTool(c, 'agents_list', {});
  expect(res.isError).toBe(false);
  const backend = res.json.backends.find((b: any) => b.id === 'kiro');
  expect(backend).toBeTruthy();
  expect(backend.profiles).toContain('audit');
  expect(backend.profiles).toContain('review');
  expect(typeof backend.available).toBe('boolean');
  return backend.available;
}

function expectUnavailableDispatch(res: Awaited<ReturnType<typeof callTool>>): void {
  expect(res.isError).toBe(true);
  expect(res.json?.error ?? res.text).toContain('PRECONDITION_FAILED');
  expect(res.text).toMatch(/backend kiro .*unavailable in this runtime/i);
  expect(res.json?.jobId).toBeUndefined();
}

// Live durability + startup recovery against an explicitly selected Compose
// project. Canonical project `quarangate` is fail-closed unless separately opted in.
//
// Current-contract note: restart/recovery can be proven only when the live Kiro
// backend is actually runtime-available. When the executor truthfully reports a
// configured/granted backend as unavailable, dispatch must fail closed before any
// durable job is queued or persisted; the restart path is then not exercised.
describe('A2 durable persistence + startup recovery (live)', () => {
  let owner: Client;
  afterAll(async () => { await owner?.close(); });

  it('recovers durable jobs when backend is available, or fails closed before persistence when unavailable', async () => {
    owner = await connect(keys.itest_agent_owner);

    const available = await kiroAvailable(owner);

    // If the real Kiro runtime is unavailable, this gate must not fabricate a
    // fake durable job. Dispatch must fail before job insertion, matching the
    // current JobEngine runtime-availability boundary.
    if (!available) {
      const res = await callTool(owner, 'agent_dispatch', {
        backend: 'kiro', project: 'mcp-ide-bridge', profile: 'audit',
        prompt: 'persistence: quick completing job',
      });
      expectUnavailableDispatch(res);
      return;
    }

    // 1) A job that completes, to prove durable survival of a finished record.
    const done = await callTool(owner, 'agent_dispatch', {
      backend: 'kiro', project: 'mcp-ide-bridge', profile: 'audit',
      prompt: 'persistence: quick completing job',
    });
    expect(done.isError).toBe(false);
    const doneId = done.json.jobId;
    expect(doneId).toMatch(/^job_[0-9a-f]{32}$/);
    for (let i = 0; i < 100 && (await status(owner, doneId)) !== 'COMPLETED'; i++) await sleep(100);
    expect(await status(owner, doneId)).toBe('COMPLETED');

    // 2) Occupy the engine (A active) + queue two more (B, C QUEUED) using the
    //    slower `standard` fake run (~1.5s). Global serialization keeps B,C queued.
    const da = await callTool(owner, 'agent_dispatch', { backend: 'kiro', project: 'mcp-ide-bridge', profile: 'review', prompt: 'active job A', resourcePolicy: 'standard' });
    const db = await callTool(owner, 'agent_dispatch', { backend: 'kiro', project: 'mcp-ide-bridge', profile: 'review', prompt: 'queued job B', resourcePolicy: 'standard' });
    const dc = await callTool(owner, 'agent_dispatch', { backend: 'kiro', project: 'mcp-ide-bridge', profile: 'review', prompt: 'queued job C', resourcePolicy: 'standard' });
    expect(da.isError).toBe(false);
    expect(db.isError).toBe(false);
    expect(dc.isError).toBe(false);
    const a = da.json.jobId;
    const b = db.json.jobId;
    const c = dc.json.jobId;

    // Wait until A is actively executing and B/C are still queued.
    for (let i = 0; i < 50; i++) {
      const sa = await status(owner, a);
      if (sa === 'PREPARING' || sa === 'RUNNING' || sa === 'VALIDATING') break;
      await sleep(20);
    }
    expect(['PREPARING', 'RUNNING', 'VALIDATING']).toContain(await status(owner, a));
    expect(await status(owner, b)).toBe('QUEUED');

    // 3) Restart the executor while A is active (SIGTERM → graceful shutdown
    //    fails active work closed; hard-kill fallback is startup recover()).
    restartComposeService(runtime.project, 'executor');

    // 4) Wait for the exact project-scoped executor container to be healthy again.
    let executorHealthy = false;
    for (let i = 0; i < 60; i++) {
      try {
        const containerId = composeServiceContainerId(runtime.project, 'executor');
        if (dockerContainerHealth(containerId) === 'healthy') { executorHealthy = true; break; }
      } catch { /* transient */ }
      await sleep(1000);
    }
    expect(executorHealthy, `executor in Compose project ${runtime.project} became healthy`).toBe(true);
    await sleep(500);

    // 5) All records survived the restart.
    expect(await status(owner, doneId)).toBe('COMPLETED'); // durable
    expect(await status(owner, a)).toBe('FAILED_INFRASTRUCTURE'); // active → fail closed

    // 6) Queued jobs survived and become eligible again; they must reach a
    //    terminal state (not stuck), proving the engine resumed post-restart.
    for (const id of [b, c]) {
      let s = await status(owner, id);
      for (let i = 0; i < 100 && (s === 'QUEUED' || s === 'PREPARING' || s === 'RUNNING' || s === 'VALIDATING'); i++) {
        await sleep(100); s = await status(owner, id);
      }
      expect(s, `queued job ${id} resumed`).toBe('COMPLETED');
    }

    // 7) A failed job cannot be resurrected (retry would be a new job).
    const cancelAfterFail = await callTool(owner, 'agent_cancel', { jobId: a });
    expect(cancelAfterFail.json.status).toBe('FAILED_INFRASTRUCTURE');
  }, 120_000);
});
