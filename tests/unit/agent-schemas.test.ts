import { describe, it, expect } from 'vitest';
import {
  AGENT_TOOL_SCHEMAS,
  agentDispatchInput,
  agentDiffInput,
  agentProjectsOutput,
  agentResultOutput,
  MAX_AGENT_DIFF_CHUNK_BYTES,
} from '../../src/gateway/agentSchemas.js';
import { MAX_AGENT_PROMPT_CHARS } from '../../src/shared/agents.js';

const GOOD_JOB_ID = `job_${'a'.repeat(32)}`;

const validDispatch = {
  backend: 'kiro',
  project: 'example-project',
  profile: 'implement',
  prompt: 'Implement the approved bounded task.',
};

/** Docker/host options a caller must never be able to smuggle. */
const INJECTED_FIELDS: Record<string, unknown> = {
  hostPath: '/home/user/project',
  cwd: '/home/user',
  image: 'evil:latest',
  runnerImage: 'evil:latest',
  mounts: ['/:/host'],
  volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
  privileged: true,
  networkMode: 'host',
  dockerSocket: '/var/run/docker.sock',
};

describe('agent tool contract schemas', () => {
  it('defines exactly the nine planned tools', () => {
    expect(Object.keys(AGENT_TOOL_SCHEMAS).sort()).toEqual([
      'agent_apply', 'agent_cancel', 'agent_diff', 'agent_discard', 'agent_dispatch',
      'agent_projects', 'agent_result', 'agent_status', 'agents_list',
    ]);
  });

  it('accepts a minimal valid dispatch', () => {
    expect(agentDispatchInput.safeParse(validDispatch).success).toBe(true);
    expect(agentDispatchInput.safeParse({ ...validDispatch, resourcePolicy: 'deep', sessionPolicy: 'new' }).success).toBe(true);
  });

  it('rejects every injected Docker/host field on every tool input', () => {
    for (const [name, { input }] of Object.entries(AGENT_TOOL_SCHEMAS)) {
      const valid =
        name === 'agent_dispatch' ? validDispatch :
        name === 'agents_list' || name === 'agent_projects' ? {} :
        { jobId: GOOD_JOB_ID };
      expect(input.safeParse(valid).success, `${name} baseline`).toBe(true);
      for (const [field, value] of Object.entries(INJECTED_FIELDS)) {
        const res = input.safeParse({ ...valid, [field]: value });
        expect(res.success, `${name} must reject ${field}`).toBe(false);
      }
    }
  });

  it('rejects arbitrary unknown fields (strict objects)', () => {
    expect(agentDispatchInput.safeParse({ ...validDispatch, anything: 1 }).success).toBe(false);
    expect(AGENT_TOOL_SCHEMAS.agent_status.input.safeParse({ jobId: GOOD_JOB_ID, verbose: true }).success).toBe(false);
    expect(AGENT_TOOL_SCHEMAS.agents_list.input.safeParse({ all: true }).success).toBe(false);
  });

  it('bounds the prompt and rejects oversized/empty prompts', () => {
    expect(agentDispatchInput.safeParse({ ...validDispatch, prompt: 'x'.repeat(MAX_AGENT_PROMPT_CHARS) }).success).toBe(true);
    expect(agentDispatchInput.safeParse({ ...validDispatch, prompt: 'x'.repeat(MAX_AGENT_PROMPT_CHARS + 1) }).success).toBe(false);
    expect(agentDispatchInput.safeParse({ ...validDispatch, prompt: '' }).success).toBe(false);
  });

  it('rejects unknown backend/profile/resource-policy ids and bad project ids', () => {
    expect(agentDispatchInput.safeParse({ ...validDispatch, backend: 'gemini' }).success).toBe(false);
    expect(agentDispatchInput.safeParse({ ...validDispatch, profile: 'yolo' }).success).toBe(false);
    expect(agentDispatchInput.safeParse({ ...validDispatch, resourcePolicy: 'unlimited' }).success).toBe(false);
    for (const project of ['/etc', '../up', 'Has Space', 'UPPER', '']) {
      expect(agentDispatchInput.safeParse({ ...validDispatch, project }).success, `project ${project}`).toBe(false);
    }
  });

  it('rejects malformed job ids on all job-addressed tools', () => {
    const badIds = ['', 'job_', 'job_123', `job_${'A'.repeat(32)}`, `job_${'a'.repeat(31)}`, 'x'.repeat(37), `../${'a'.repeat(32)}`];
    for (const name of ['agent_status', 'agent_result', 'agent_diff', 'agent_cancel', 'agent_apply', 'agent_discard'] as const) {
      for (const jobId of badIds) {
        expect(AGENT_TOOL_SCHEMAS[name].input.safeParse({ jobId }).success, `${name} jobId=${jobId}`).toBe(false);
      }
      expect(AGENT_TOOL_SCHEMAS[name].input.safeParse({ jobId: GOOD_JOB_ID }).success).toBe(true);
    }
  });

  it('agent_diff supports bounded selective retrieval only', () => {
    expect(agentDiffInput.safeParse({ jobId: GOOD_JOB_ID, path: 'src/app.ts', maxBytes: 4096 }).success).toBe(true);
    expect(agentDiffInput.safeParse({ jobId: GOOD_JOB_ID, path: '/etc/passwd' }).success).toBe(false);
    expect(agentDiffInput.safeParse({ jobId: GOOD_JOB_ID, path: '../escape' }).success).toBe(false);
    expect(agentDiffInput.safeParse({ jobId: GOOD_JOB_ID, maxBytes: MAX_AGENT_DIFF_CHUNK_BYTES + 1 }).success).toBe(false);
    expect(agentDiffInput.safeParse({ jobId: GOOD_JOB_ID, maxBytes: 0 }).success).toBe(false);
    expect(agentDiffInput.safeParse({ jobId: GOOD_JOB_ID, cursor: 'c'.repeat(257) }).success).toBe(false);
  });

  it('agent_apply accepts no caller patch text', () => {
    expect(AGENT_TOOL_SCHEMAS.agent_apply.input.safeParse({ jobId: GOOD_JOB_ID, patch: 'diff --git a b' }).success).toBe(false);
    expect(AGENT_TOOL_SCHEMAS.agent_apply.input.safeParse({ jobId: GOOD_JOB_ID }).success).toBe(true);
  });

  it('agent_projects output never carries hostPath', () => {
    const good = { projects: [{ id: 'example-project', gitRequired: true, allowedBackends: ['kiro'], allowedProfiles: ['audit'] }] };
    expect(agentProjectsOutput.safeParse(good).success).toBe(true);
    const leaking = { projects: [{ ...good.projects[0], hostPath: '/srv/projects/example-project' }] };
    expect(agentProjectsOutput.safeParse(leaking).success).toBe(false);
  });

  it('result output permits honest missing usage and forbids transcript dumps', () => {
    const good = {
      jobId: GOOD_JOB_ID,
      status: 'COMPLETED',
      backend: 'kiro',
      project: 'example-project',
      profile: 'implement',
      summary: 'Implemented and validated.',
      usage: { usageAvailable: false },
    };
    expect(agentResultOutput.safeParse(good).success).toBe(true);
    expect(agentResultOutput.safeParse({ ...good, transcript: 'full log...' }).success).toBe(false);
    expect(agentResultOutput.safeParse({ ...good, summary: 'x'.repeat(20_000) }).success).toBe(false);
    expect(agentResultOutput.safeParse({ ...good, changedFiles: ['/etc/passwd'] }).success).toBe(false);
  });

  it('every schema pair exists and outputs are strict objects', () => {
    for (const [name, pair] of Object.entries(AGENT_TOOL_SCHEMAS)) {
      expect(pair.input, `${name} input`).toBeDefined();
      expect(pair.output, `${name} output`).toBeDefined();
      expect(pair.output.safeParse({ unexpected: true }).success, `${name} output strict`).toBe(false);
    }
  });
});
