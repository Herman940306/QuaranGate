import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizeAgentTool,
  principalMayUseAgentProject,
  principalMayUseAgentBackend,
  principalMayUseAgentProfile,
  principalOwnsAgentJob,
  AGENT_TOOL_NAMES,
  AGENT_TOOL_REQUIRED_SCOPE,
  type AgentJobRef,
} from '../../src/gateway/agentAuthz.js';
import { loadClients, principalById, principalHasScope, type Principal, ALL_SCOPES } from '../../src/gateway/config.js';

function makePrincipal(over: Partial<Principal> = {}): Principal {
  return {
    id: 'orchestrator',
    name: 'Orchestrator',
    keyHash: 'a'.repeat(64),
    scopes: ['agents:read', 'agents:dispatch', 'agents:cancel', 'agents:apply'],
    targets: [],
    enabled: true,
    projects: ['example-project'],
    agentBackends: ['kiro'],
    agentProfiles: ['audit', 'plan', 'implement'],
    ...over,
  };
}

const ownJob: AgentJobRef = { jobId: `job_${'0'.repeat(32)}`, principalId: 'orchestrator', project: 'example-project' };
const foreignJob: AgentJobRef = { jobId: `job_${'1'.repeat(32)}`, principalId: 'someone-else', project: 'example-project' };

describe('agent authorization matrix', () => {
  it('covers all nine tools with a scope requirement', () => {
    expect(AGENT_TOOL_NAMES).toHaveLength(9);
    for (const t of AGENT_TOOL_NAMES) expect(AGENT_TOOL_REQUIRED_SCOPE[t]).toMatch(/^agents:/);
    expect(AGENT_TOOL_REQUIRED_SCOPE.agent_discard).toBe('agents:dispatch');
  });

  it('allows a fully granted dispatch', () => {
    const d = authorizeAgentTool({ tool: 'agent_dispatch', principal: makePrincipal(), project: 'example-project', backend: 'kiro', profile: 'implement' });
    expect(d.allowed).toBe(true);
  });

  it('denies dispatch without the agents:dispatch scope', () => {
    const p = makePrincipal({ scopes: ['agents:read'] });
    const d = authorizeAgentTool({ tool: 'agent_dispatch', principal: p, project: 'example-project', backend: 'kiro', profile: 'audit' });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_SCOPE' });
  });

  it('denies dispatch without a project grant', () => {
    const d = authorizeAgentTool({ tool: 'agent_dispatch', principal: makePrincipal(), project: 'other-project', backend: 'kiro', profile: 'audit' });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_PROJECT' });
  });

  it('denies dispatch without a backend grant', () => {
    const d = authorizeAgentTool({ tool: 'agent_dispatch', principal: makePrincipal(), project: 'example-project', backend: 'copilot', profile: 'audit' });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_BACKEND' });
  });

  it('denies dispatch without a profile grant', () => {
    const d = authorizeAgentTool({ tool: 'agent_dispatch', principal: makePrincipal(), project: 'example-project', backend: 'kiro', profile: 'review' });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_PROFILE' });
  });

  it('denies dispatch with missing dimensions as malformed', () => {
    const d = authorizeAgentTool({ tool: 'agent_dispatch', principal: makePrincipal(), project: 'example-project' });
    expect(d).toMatchObject({ allowed: false, code: 'MALFORMED_REQUEST' });
  });

  it('target permission alone grants ZERO agent access', () => {
    const p = makePrincipal({
      scopes: ['targets:read', 'files:read', 'files:write', 'terminal:exec', 'git:read'],
      targets: ['*'],
      projects: [],
      agentBackends: [],
      agentProfiles: [],
    });
    for (const tool of AGENT_TOOL_NAMES) {
      const d = authorizeAgentTool({ tool, principal: p, project: 'example-project', backend: 'kiro', profile: 'audit', job: ownJob });
      expect(d.allowed, tool).toBe(false);
      expect((d as { code: string }).code).toBe('FORBIDDEN_SCOPE');
    }
    expect(principalMayUseAgentProject(p, 'example-project')).toBe(false);
  });

  it('agent scope without resource grants still denies dispatch', () => {
    const p = makePrincipal({ projects: [], agentBackends: [], agentProfiles: [] });
    const d = authorizeAgentTool({ tool: 'agent_dispatch', principal: p, project: 'example-project', backend: 'kiro', profile: 'audit' });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_PROJECT' });
  });

  it('job-addressed tools require ownership', () => {
    for (const tool of ['agent_status', 'agent_result', 'agent_diff', 'agent_cancel', 'agent_apply', 'agent_discard'] as const) {
      expect(authorizeAgentTool({ tool, principal: makePrincipal(), job: ownJob }).allowed, `${tool} own`).toBe(true);
      expect(authorizeAgentTool({ tool, principal: makePrincipal(), job: foreignJob }), `${tool} foreign`)
        .toMatchObject({ allowed: false, code: 'FORBIDDEN_JOB' });
      expect(authorizeAgentTool({ tool, principal: makePrincipal() }), `${tool} no job`)
        .toMatchObject({ allowed: false, code: 'MALFORMED_REQUEST' });
    }
  });

  it('there is no cross-principal admin override', () => {
    const admin = makePrincipal({ id: 'admin', scopes: [...ALL_SCOPES], projects: ['*'], agentBackends: ['*'], agentProfiles: ['*'], targets: ['*'] });
    const d = authorizeAgentTool({ tool: 'agent_cancel', principal: admin, job: foreignJob });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_JOB' });
  });

  it('apply requires scope + ownership + project grant on the job project', () => {
    const noApply = makePrincipal({ scopes: ['agents:read', 'agents:dispatch', 'agents:cancel'] });
    expect(authorizeAgentTool({ tool: 'agent_apply', principal: noApply, job: ownJob }))
      .toMatchObject({ allowed: false, code: 'FORBIDDEN_SCOPE' });

    const noProject = makePrincipal({ projects: ['other-project'] });
    expect(authorizeAgentTool({ tool: 'agent_apply', principal: noProject, job: ownJob }))
      .toMatchObject({ allowed: false, code: 'FORBIDDEN_PROJECT' });

    expect(authorizeAgentTool({ tool: 'agent_apply', principal: makePrincipal(), job: ownJob }).allowed).toBe(true);
  });

  it('discard requires agents:dispatch, not agents:apply', () => {
    const p = makePrincipal({ scopes: ['agents:read', 'agents:dispatch'] });
    expect(authorizeAgentTool({ tool: 'agent_discard', principal: p, job: ownJob }).allowed).toBe(true);
    const readOnly = makePrincipal({ scopes: ['agents:read'] });
    expect(authorizeAgentTool({ tool: 'agent_discard', principal: readOnly, job: ownJob }))
      .toMatchObject({ allowed: false, code: 'FORBIDDEN_SCOPE' });
  });

  it('list/projects need only agents:read', () => {
    const p = makePrincipal({ scopes: ['agents:read'], projects: [], agentBackends: [], agentProfiles: [] });
    expect(authorizeAgentTool({ tool: 'agents_list', principal: p }).allowed).toBe(true);
    expect(authorizeAgentTool({ tool: 'agent_projects', principal: p }).allowed).toBe(true);
  });

  it('wildcard grants mean the whole trusted registry', () => {
    const p = makePrincipal({ projects: ['*'], agentBackends: ['*'], agentProfiles: ['*'] });
    expect(principalMayUseAgentProject(p, 'anything-configured')).toBe(true);
    expect(principalMayUseAgentBackend(p, 'copilot')).toBe(true);
    expect(principalMayUseAgentProfile(p, 'review')).toBe(true);
  });

  it('empty grants deny; ownership is exact principal identity', () => {
    const p = makePrincipal({ projects: [], agentBackends: [], agentProfiles: [] });
    expect(principalMayUseAgentProject(p, 'example-project')).toBe(false);
    expect(principalMayUseAgentBackend(p, 'kiro')).toBe(false);
    expect(principalMayUseAgentProfile(p, 'audit')).toBe(false);
    expect(principalOwnsAgentJob(p, ownJob)).toBe(true);
    expect(principalOwnsAgentJob(p, foreignJob)).toBe(false);
  });
});

describe('backward compatibility of clients.yaml', () => {
  function loadYaml(yaml: string): void {
    const dir = mkdtempSync(join(tmpdir(), 'mcpb-agents-'));
    const path = join(dir, 'clients.yaml');
    writeFileSync(path, yaml);
    loadClients(path);
  }

  it('a pre-A1 client config parses and yields zero agent authorization', () => {
    loadYaml(`clients:
  - id: legacy
    name: Legacy
    keyHash: "${'b'.repeat(64)}"
    enabled: true
    scopes: [targets:read, files:read, files:write, files:delete, terminal:exec, git:read, process:read]
    targets: ["*"]
`);
    const p = principalById('legacy')!;
    expect(p).toBeDefined();
    // Existing seven scopes still work.
    for (const s of ['targets:read', 'files:read', 'files:write', 'files:delete', 'terminal:exec', 'git:read', 'process:read'] as const) {
      expect(principalHasScope(p, s)).toBe(true);
    }
    // Zero agent privileges by default.
    for (const s of ['agents:read', 'agents:dispatch', 'agents:cancel', 'agents:apply'] as const) {
      expect(principalHasScope(p, s)).toBe(false);
    }
    expect(p.projects).toEqual([]);
    expect(p.agentBackends).toEqual([]);
    expect(p.agentProfiles).toEqual([]);
    for (const tool of AGENT_TOOL_NAMES) {
      expect(authorizeAgentTool({ tool, principal: p, project: 'x', backend: 'kiro', profile: 'audit', job: { jobId: 'job_' + 'c'.repeat(32), principalId: 'legacy', project: 'x' } }).allowed).toBe(false);
    }
  });

  it('new agent scopes are recognized only when explicitly configured', () => {
    loadYaml(`clients:
  - id: agentclient
    name: Agent Client
    keyHash: "${'c'.repeat(64)}"
    enabled: true
    scopes: [agents:read, agents:dispatch, bogus:scope]
    targets: []
    projects: ["example-project"]
    agentBackends: ["kiro"]
    agentProfiles: [audit]
`);
    const p = principalById('agentclient')!;
    expect(principalHasScope(p, 'agents:read')).toBe(true);
    expect(principalHasScope(p, 'agents:dispatch')).toBe(true);
    expect(principalHasScope(p, 'agents:apply')).toBe(false);
    expect(p.scopes).not.toContain('bogus:scope'); // unknown scopes filtered (fail closed)
    expect(p.projects).toEqual(['example-project']);
  });
});
