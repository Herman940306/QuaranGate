import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentConfigYaml, validateAgentConfig } from '../../src/executor/agentConfig.js';
import { BridgeError } from '../../src/shared/errors.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Minimal valid config used as the mutation baseline. */
function base(): any {
  return {
    backends: [
      { id: 'kiro', enabled: true, profiles: ['audit', 'implement'], defaultResourcePolicy: 'standard' },
    ],
    projects: [
      { id: 'example-project', hostPath: '/srv/projects/example-project', gitRequired: true, backends: ['kiro'], profiles: ['audit', 'implement'], guardedPaths: ['.env'] },
    ],
    profiles: [
      { id: 'audit', workspaceAccess: 'read-only', shellPolicy: 'read-only', gitPolicy: 'read', networkPolicy: 'backend-only', defaultResourcePolicy: 'economy' },
      { id: 'implement', workspaceAccess: 'sandbox-write', shellPolicy: 'validation', gitPolicy: 'sandbox', networkPolicy: 'backend-only', defaultResourcePolicy: 'standard' },
    ],
    resourcePolicies: [
      { id: 'economy', modelClass: 'fast', maxRuntimeMs: 600_000, maxCpuMillicores: 1000, maxMemoryBytes: 1024 ** 3, maxPids: 128, maxOutputBytes: 262_144, maxEvidenceBytes: 10 * 1024 ** 2, networkPolicy: 'deny', retentionClass: 'ephemeral' },
      { id: 'standard', modelClass: 'standard', maxRuntimeMs: 1_800_000, maxCpuMillicores: 2000, maxMemoryBytes: 2 * 1024 ** 3, maxPids: 256, maxOutputBytes: 262_144, maxEvidenceBytes: 50 * 1024 ** 2, networkPolicy: 'backend-only', retentionClass: 'short' },
    ],
  };
}

const expectReject = (cfg: unknown, why: string) => {
  expect(() => validateAgentConfig(cfg), why).toThrow(BridgeError);
};

describe('agent control plane config', () => {
  it('accepts the strict minimal config', () => {
    const cfg = validateAgentConfig(base());
    expect(cfg.projects[0]!.id).toBe('example-project');
    expect(cfg.backends[0]!.defaultResourcePolicy).toBe('standard');
  });

  it('accepts the shipped example file (config/agents.example.yaml)', () => {
    const cfg = parseAgentConfigYaml(readFileSync(join(repoRoot, 'config', 'agents.example.yaml'), 'utf8'));
    expect(cfg.backends.map((b) => b.id).sort()).toEqual(['copilot', 'kiro', 'ollama']);
    expect(cfg.profiles).toHaveLength(4);
    expect(cfg.resourcePolicies.map((r) => r.id).sort()).toEqual(['deep', 'economy', 'standard']);
    // The example must never contain a real Herman host path.
    for (const p of cfg.projects) expect(p.hostPath.startsWith('/srv/projects/')).toBe(true);
  });

  it('rejects invalid project ids', () => {
    for (const id of ['Bad', 'has space', '-lead', 'a'.repeat(65), '', 'UPPER', 'dot.dot']) {
      const c = base();
      c.projects[0].id = id;
      expectReject(c, `project id ${JSON.stringify(id)}`);
    }
  });

  it('rejects relative/traversal/malformed hostPath', () => {
    for (const hp of ['relative/path', './x', '../x', '/srv/../etc', 'C:\\projects', '', '/x\0y']) {
      const c = base();
      c.projects[0].hostPath = hp;
      expectReject(c, `hostPath ${JSON.stringify(hp)}`);
    }
  });

  it('rejects unknown backend/profile/policy references', () => {
    let c = base();
    c.projects[0].backends = ['copilot']; // not defined in this config
    expectReject(c, 'project references undefined backend');

    c = base();
    c.backends[0].profiles = ['audit', 'review']; // review not defined
    expectReject(c, 'backend references undefined profile');

    c = base();
    c.profiles[0].defaultResourcePolicy = 'deep'; // not defined
    expectReject(c, 'profile references undefined policy');

    c = base();
    c.backends[0].defaultResourcePolicy = 'deep';
    expectReject(c, 'backend references undefined policy');
  });

  it('rejects ids outside the closed enums', () => {
    let c = base();
    c.backends.push({ ...base().backends[0], id: 'gemini' });
    expectReject(c, 'unknown backend id');

    c = base();
    c.profiles.push({ ...base().profiles[0], id: 'yolo' });
    expectReject(c, 'unknown profile id');

    c = base();
    c.resourcePolicies.push({ ...base().resourcePolicies[0], id: 'unlimited' });
    expectReject(c, 'unknown policy id');
  });

  it('rejects duplicate ids', () => {
    for (const key of ['backends', 'projects', 'profiles', 'resourcePolicies'] as const) {
      const c = base();
      c[key].push(structuredClone(c[key][0]));
      expectReject(c, `duplicate in ${key}`);
    }
  });

  it('rejects bad resource limits', () => {
    const bad: Array<[string, unknown]> = [
      ['maxRuntimeMs', 0],
      ['maxRuntimeMs', 999],
      ['maxRuntimeMs', 25 * 3_600_000],
      ['maxCpuMillicores', 1.5],
      ['maxCpuMillicores', -1000],
      ['maxMemoryBytes', 1024],
      ['maxPids', 0],
      ['maxOutputBytes', -1],
      ['maxEvidenceBytes', 0],
      ['maxProviderCredits', -5],
    ];
    for (const [field, value] of bad) {
      const c = base();
      c.resourcePolicies[0][field] = value;
      expectReject(c, `${field}=${value}`);
    }
  });

  it('rejects unknown keys at every level', () => {
    let c = base();
    c.dockerSocket = '/var/run/docker.sock';
    expectReject(c, 'top-level unknown key');

    c = base();
    c.projects[0].mounts = ['/:/host'];
    expectReject(c, 'project unknown key');

    c = base();
    c.backends[0].image = 'evil:latest';
    expectReject(c, 'backend unknown key');

    c = base();
    c.profiles[0].privileged = true;
    expectReject(c, 'profile unknown key');

    c = base();
    c.resourcePolicies[0].networkMode = 'host';
    expectReject(c, 'policy unknown key');
  });

  it('rejects an unrestricted network policy — only deny/backend-only exist', () => {
    const c = base();
    c.resourcePolicies[0].networkPolicy = 'unrestricted';
    expectReject(c, 'unrestricted network');
  });

  it('rejects sandbox-write on non-writer profiles', () => {
    const c = base();
    c.profiles[0].workspaceAccess = 'sandbox-write'; // audit must stay read-only
    expectReject(c, 'audit with sandbox-write');
  });

  it('rejects a transport field on backends (A7 decision, not config)', () => {
    const c = base();
    c.backends[0].transport = 'cli';
    expectReject(c, 'backend transport key');
  });

  it('rejects malformed YAML', () => {
    expect(() => parseAgentConfigYaml(':::not yaml:::[')).toThrow(BridgeError);
  });
});
