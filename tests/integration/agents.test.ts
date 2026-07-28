/**
 * A2 integration — live stack, six activated Agent Control Plane tools.
 *
 * Requires KEYS_ENV with KEY_itest_agent_owner / KEY_itest_agent_other
 * (dedicated A2 test principals; no browser principal has agent scopes).
 * Runs against the deterministic fake engine only — no real agent/provider.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, callTool, loadKeys } from './helpers.js';

const keys = loadKeys();

const AGENT_TOOLS = ['agents_list', 'agent_projects', 'agent_dispatch', 'agent_status', 'agent_result', 'agent_cancel'];
const CONTRACT_ONLY = ['agent_diff', 'agent_apply', 'agent_discard'];

async function waitForStatus(client: Client, jobId: string, want: (s: string) => boolean, ms = 15_000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const res = await callTool(client, 'agent_status', { jobId });
    if (!res.isError && want(res.json.status)) return res.json;
    if (Date.now() - start > ms) throw new Error(`timeout waiting on ${jobId}: ${JSON.stringify(res.json)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('Agent Control Plane — A2 live integration', () => {
  let owner: Client;
  let other: Client;

  beforeAll(async () => {
    owner = await connect(keys.itest_agent_owner);
    other = await connect(keys.itest_agent_other);
  });

  afterAll(async () => {
    await owner?.close();
    await other?.close();
  });

  describe('tool surface', () => {
    it('exposes exactly 20 operational tools, all with object outputSchema', async () => {
      const { tools } = await owner.listTools();
      expect(tools).toHaveLength(20);
      for (const t of tools) {
        expect(t.outputSchema, `${t.name} missing outputSchema`).toBeTruthy();
        expect(t.outputSchema?.type, `${t.name} outputSchema type`).toBe('object');
      }
      const names = tools.map((t) => t.name);
      for (const t of AGENT_TOOLS) expect(names, `missing ${t}`).toContain(t);
    });

    it('agent_diff / agent_apply / agent_discard remain unregistered', async () => {
      const { tools } = await owner.listTools();
      const names = tools.map((t) => t.name);
      for (const t of CONTRACT_ONLY) expect(names, `${t} must not be live`).not.toContain(t);
      for (const t of CONTRACT_ONLY) {
        const res = await callTool(owner, t, { jobId: `job_${'a'.repeat(32)}` }).catch((e) => ({ isError: true, text: String(e), json: undefined }));
        expect(res.isError, `${t} call must fail`).toBe(true);
      }
    });

    it('existing tools still operate (targets_list)', async () => {
      const res = await callTool(owner, 'targets_list', {});
      expect(res.isError).toBe(false);
      expect(res.json.targets.some((t: any) => t.id === 'demo')).toBe(true);
    });
  });

  describe('discovery', () => {
    it('agents_list returns only granted backends', async () => {
      const res = await callTool(owner, 'agents_list', {});
      expect(res.isError).toBe(false);
      expect(res.json.backends).toHaveLength(1);
      expect(res.json.backends[0].id).toBe('kiro');
      expect(res.json.backends[0].available).toBe(true);
      expect(res.json.backends[0].profiles).toContain('implement');
    });

    it('agent_projects returns logical info only — never hostPath', async () => {
      const res = await callTool(owner, 'agent_projects', {});
      expect(res.isError).toBe(false);
      const p = res.json.projects.find((x: any) => x.id === 'mcp-ide-bridge');
      expect(p).toBeTruthy();
      expect(p.gitRequired).toBe(true);
      expect(p.allowedBackends).toEqual(['kiro']);
      expect(JSON.stringify(res.json)).not.toContain('hostPath');
      expect(JSON.stringify(res.json)).not.toContain('/home/');
    });
  });

  describe('dispatch → status → result', () => {
    it('dispatch returns a jobId quickly and the job completes with a bounded honest result', async () => {
      const t0 = Date.now();
      const d = await callTool(owner, 'agent_dispatch', {
        backend: 'kiro', project: 'mcp-ide-bridge', profile: 'audit',
        prompt: 'A2 integration: describe nothing, complete deterministically.',
      });
      const dispatchMs = Date.now() - t0;
      expect(d.isError).toBe(false);
      expect(d.json.jobId).toMatch(/^job_[0-9a-f]{32}$/);
      expect(dispatchMs).toBeLessThan(3000); // no long-held MCP request
      expect(['QUEUED', 'PREPARING']).toContain(d.json.status);
      expect(d.json.resourcePolicy).toBe('economy'); // audit profile default

      const final = await waitForStatus(owner, d.json.jobId, (s) => s === 'COMPLETED');
      expect(final.failureCode).toBeUndefined();
      expect(final.startedAt).toBeTruthy();
      expect(final.completedAt).toBeTruthy();

      const r = await callTool(owner, 'agent_result', { jobId: d.json.jobId });
      expect(r.isError).toBe(false);
      expect(r.json.status).toBe('COMPLETED');
      expect(r.json.summary).toContain('Fake backend completed successfully');
      expect(r.json.changedFiles).toEqual([]);
      expect(r.json.usage).toEqual({ usageAvailable: false });
      expect(r.json.exitCode).toBe(0);
      // The prompt is never returned.
      expect(r.text).not.toContain('describe nothing');
    });

    it('rejects dangerous unknown public properties (strict schemas live)', async () => {
      for (const extra of [
        { hostPath: '/home/herman' },
        { runnerImage: 'evil:latest' },
        { mounts: ['/:/host'] },
        { privileged: true },
        { networkMode: 'host' },
        { dockerSocket: '/var/run/docker.sock' },
      ]) {
        const res = await callTool(owner, 'agent_dispatch', {
          backend: 'kiro', project: 'mcp-ide-bridge', profile: 'audit', prompt: 'x', ...extra,
        }).catch((e) => ({ isError: true, text: String(e), json: undefined as any }));
        expect(res.isError, `must reject ${Object.keys(extra)[0]}`).toBe(true);
      }
    });

    it('rejects sessionPolicy resume explicitly', async () => {
      const res = await callTool(owner, 'agent_dispatch', {
        backend: 'kiro', project: 'mcp-ide-bridge', profile: 'audit', prompt: 'x', sessionPolicy: 'resume',
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('A8');
    });
  });

  describe('cancellation', () => {
    it('cancels a deterministic delayed job', async () => {
      // standard policy → fake run phase ~1.5 s: reliably cancellable.
      const d = await callTool(owner, 'agent_dispatch', {
        backend: 'kiro', project: 'mcp-ide-bridge', profile: 'review',
        prompt: 'A2 integration: delayed fake job for cancellation.', resourcePolicy: 'standard',
      });
      expect(d.isError).toBe(false);
      const c = await callTool(owner, 'agent_cancel', { jobId: d.json.jobId });
      expect(c.isError).toBe(false);
      expect(['CANCELLED', 'QUEUED']).toContain(c.json.status);
      const final = await waitForStatus(owner, d.json.jobId, (s) => s === 'CANCELLED');
      expect(final.failureCode).toBe('CANCELLED');
    });
  });

  describe('authorization and ownership', () => {
    let ownerJob: string;

    beforeAll(async () => {
      const d = await callTool(owner, 'agent_dispatch', {
        backend: 'kiro', project: 'mcp-ide-bridge', profile: 'audit', prompt: 'ownership probe job',
      });
      expect(d.isError).toBe(false);
      ownerJob = d.json.jobId;
    });

    it('another principal cannot inspect the job', async () => {
      const res = await callTool(other, 'agent_status', { jobId: ownerJob });
      expect(res.isError).toBe(true);
      expect(res.json?.error ?? res.text).toContain('FORBIDDEN_JOB');
      const r2 = await callTool(other, 'agent_result', { jobId: ownerJob });
      expect(r2.isError).toBe(true);
    });

    it('another principal cannot cancel the job', async () => {
      const res = await callTool(other, 'agent_cancel', { jobId: ownerJob });
      expect(res.isError).toBe(true);
      expect(res.json?.error ?? res.text).toContain('FORBIDDEN_JOB');
    });

    it('a principal without agents:dispatch cannot create a job', async () => {
      const res = await callTool(other, 'agent_dispatch', {
        backend: 'kiro', project: 'mcp-ide-bridge', profile: 'audit', prompt: 'should never persist',
      });
      expect(res.isError).toBe(true);
      expect(res.json?.error ?? res.text).toContain('FORBIDDEN_SCOPE');
    });

    it('dispatch against an ungranted profile is denied before any job exists', async () => {
      // owner grants include all profiles, but 'other' has only audit AND no
      // dispatch scope; owner with unknown project id exercises project denial:
      const res = await callTool(owner, 'agent_dispatch', {
        backend: 'kiro', project: 'not-a-project', profile: 'audit', prompt: 'x',
      });
      expect(res.isError).toBe(true);
      expect(res.json?.error ?? res.text).toContain('FORBIDDEN_PROJECT');
    });
  });
});
