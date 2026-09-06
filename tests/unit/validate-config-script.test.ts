import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../..');
const scriptPath = join(repoRoot, 'scripts/validate-config.mjs');
const tempDirs: string[] = [];

type AgentConfig = {
  backends: Array<{
    id: string;
    enabled: boolean;
    profiles: string[];
    defaultResourcePolicy: string;
  }>;
  projects: Array<{
    id: string;
    hostPath: string;
    gitRequired: boolean;
    backends: string[];
    profiles: string[];
    guardedPaths?: unknown;
    sensitiveReadGlobs?: unknown;
    [key: string]: unknown;
  }>;
  profiles: Array<{
    id: string;
    workspaceAccess: string;
    shellPolicy: string;
    gitPolicy: string;
    networkPolicy: string;
    defaultResourcePolicy: string;
  }>;
  resourcePolicies: Array<{
    id: string;
    modelClass: string;
    maxRuntimeMs: number;
    maxCpuMillicores: number;
    maxMemoryBytes: number;
    maxPids: number;
    maxOutputBytes: number;
    maxEvidenceBytes: number;
    maxProviderCredits?: number;
    networkPolicy: string;
    retentionClass: string;
  }>;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function baseAgentsConfig(): AgentConfig {
  return {
    backends: [
      { id: 'ollama', enabled: true, profiles: ['audit'], defaultResourcePolicy: 'economy' },
    ],
    projects: [
      {
        id: 'demo',
        hostPath: '/workspace/demo',
        gitRequired: true,
        backends: ['ollama'],
        profiles: ['audit'],
        guardedPaths: ['secrets/**'],
        sensitiveReadGlobs: ['private/**'],
      },
    ],
    profiles: [
      {
        id: 'audit',
        workspaceAccess: 'read-only',
        shellPolicy: 'read-only',
        gitPolicy: 'read',
        networkPolicy: 'backend-only',
        defaultResourcePolicy: 'economy',
      },
    ],
    resourcePolicies: [
      {
        id: 'economy',
        modelClass: 'fast',
        maxRuntimeMs: 60_000,
        maxCpuMillicores: 1_000,
        maxMemoryBytes: 536_870_912,
        maxPids: 64,
        maxOutputBytes: 1_048_576,
        maxEvidenceBytes: 1_048_576,
        networkPolicy: 'backend-only',
        retentionClass: 'ephemeral',
      },
    ],
  };
}

function runValidator(mutator?: (config: AgentConfig) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'quarangate-validate-config-'));
  tempDirs.push(dir);

  const clientsPath = join(dir, 'clients.yaml');
  const bridgePath = join(dir, 'bridge.yaml');
  const agentsPath = join(dir, 'agents.yaml');
  const agents = baseAgentsConfig();
  mutator?.(agents);

  writeFileSync(clientsPath, YAML.stringify({
    clients: [
      {
        id: 'test-client',
        keyHash: 'a'.repeat(64),
        scopes: ['targets:read'],
        targets: ['demo-target'],
      },
    ],
  }));
  writeFileSync(bridgePath, YAML.stringify({
    targets: [
      {
        id: 'demo-target',
        workspace: '/workspace/demo',
        containerName: 'demo-container',
      },
    ],
  }));
  writeFileSync(agentsPath, YAML.stringify(agents));

  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLIENTS_CONFIG: clientsPath,
      BRIDGE_CONFIG: bridgePath,
      AGENTS_CONFIG: agentsPath,
    },
    encoding: 'utf8',
  });
}

function outputOf(result: ReturnType<typeof runValidator>): string {
  return `${result.stdout}${result.stderr}`;
}

function expectRejected(mutator: (config: AgentConfig) => void, message: string): void {
  const result = runValidator(mutator);

  expect(result.status).toBe(1);
  expect(outputOf(result)).toContain(message);
}

describe('scripts/validate-config.mjs agent schema parity', () => {

  it('accepts the explicit targets:control scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quarangate-validate-control-'));
    tempDirs.push(dir);
    const clientsPath = join(dir, 'clients.yaml');
    const bridgePath = join(dir, 'bridge.yaml');
    writeFileSync(clientsPath, YAML.stringify({ clients: [{ id: 'owner', keyHash: 'a'.repeat(64), scopes: ['targets:read', 'targets:control', 'targets:logs'], targets: ['demo-target'] }] }));
    writeFileSync(bridgePath, YAML.stringify({ targets: [{ id: 'demo-target', workspace: '/workspace', containerName: 'demo' }] }));
    const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, env: { ...process.env, CLIENTS_CONFIG: clientsPath, BRIDGE_CONFIG: bridgePath, AGENTS_CONFIG: '' }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(outputOf(result)).not.toContain('unknown scope targets:control');
    expect(outputOf(result)).not.toContain('unknown scope targets:logs');
  });
  it('accepts a valid Ollama backend with sensitiveReadGlobs', () => {
    const result = runValidator();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('rejects an unknown backend id', () => {
    const result = runValidator((config) => {
      config.backends[0].id = 'unknown';
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('unknown backend id unknown');
  });

  it('rejects an unknown project key', () => {
    const result = runValidator((config) => {
      config.projects[0].extraKey = true;
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('project demo: unknown project key extraKey');
  });

  it('rejects sensitiveReadGlobs when it is not an array', () => {
    const result = runValidator((config) => {
      config.projects[0].sensitiveReadGlobs = 'private/**';
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('project demo: sensitiveReadGlobs must be a list');
  });

  it('rejects an empty sensitiveReadGlobs entry', () => {
    const result = runValidator((config) => {
      config.projects[0].sensitiveReadGlobs = [''];
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('project demo: sensitiveReadGlobs entries must be 1..512 characters');
  });

  it('rejects more than 256 sensitiveReadGlobs entries', () => {
    const result = runValidator((config) => {
      config.projects[0].sensitiveReadGlobs = Array.from({ length: 257 }, (_, index) => `private/${index}`);
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('project demo: sensitiveReadGlobs must have at most 256 entries');
  });

  it('rejects a sensitiveReadGlobs entry longer than 512 characters', () => {
    const result = runValidator((config) => {
      config.projects[0].sensitiveReadGlobs = ['a'.repeat(513)];
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('project demo: sensitiveReadGlobs entries must be 1..512 characters');
  });

  it('rejects guardedPaths when it is not an array', () => {
    const result = runValidator((config) => {
      config.projects[0].guardedPaths = 'secrets/**';
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('project demo: guardedPaths must be a list');
  });

  it('rejects an empty guardedPaths entry', () => {
    const result = runValidator((config) => {
      config.projects[0].guardedPaths = [''];
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('project demo: guardedPaths entries must be 1..512 characters');
  });

  it('rejects more than 256 guardedPaths entries', () => {
    const result = runValidator((config) => {
      config.projects[0].guardedPaths = Array.from({ length: 257 }, (_, index) => `secrets/${index}`);
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('project demo: guardedPaths must have at most 256 entries');
  });

  it('rejects a guardedPaths entry longer than 512 characters', () => {
    const result = runValidator((config) => {
      config.projects[0].guardedPaths = ['a'.repeat(513)];
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('project demo: guardedPaths entries must be 1..512 characters');
  });

  it.each(['backends', 'projects', 'profiles', 'resourcePolicies'] as const)(
    'rejects %s when it is not an array',
    (field) => {
      expectRejected((config) => {
        (config as unknown as Record<string, unknown>)[field] = {};
      }, `agents: ${field} must be a list`);
    },
  );

  it.each([
    ['backend profiles', (config: AgentConfig, value: unknown) => { config.backends[0].profiles = value as string[]; }, 'backend ollama: profiles'],
    ['project backends', (config: AgentConfig, value: unknown) => { config.projects[0].backends = value as string[]; }, 'project demo: backends'],
    ['project profiles', (config: AgentConfig, value: unknown) => { config.projects[0].profiles = value as string[]; }, 'project demo: profiles'],
  ] as const)('requires a non-empty valid %s list', (_name, mutate, context) => {
    expectRejected((config) => mutate(config, []), `${context} must be a non-empty list`);
    expectRejected((config) => mutate(config, 'audit'), `${context} must be a non-empty list`);
    expectRejected((config) => mutate(config, ['not-valid']), `${context.replace(/: (profiles|backends)$/, '')}: unknown`);
  });

  it.each([
    ['too short', '/'],
    ['too long', `/${'a'.repeat(4096)}`],
    ['relative', 'workspace/demo'],
    ['traversing', '/workspace/../demo'],
    ['NUL-containing', '/workspace/\0demo'],
  ])('rejects a %s hostPath', (_name, hostPath) => {
    expectRejected((config) => {
      config.projects[0].hostPath = hostPath;
    }, 'project demo: hostPath must be 2..4096 characters, absolute, without .. segments or NUL');
  });

  it.each([
    ['shellPolicy', 'execute', 'profile audit: bad shellPolicy'],
    ['gitPolicy', 'write', 'profile audit: bad gitPolicy'],
    ['modelClass', 'small', 'policy economy: bad modelClass'],
  ] as const)('rejects an invalid %s', (field, value, message) => {
    expectRejected((config) => {
      if (field === 'modelClass') config.resourcePolicies[0].modelClass = value;
      else config.profiles[0][field] = value;
    }, message);
  });

  const resourceRanges = [
    ['maxRuntimeMs', 10_000, 86_400_000],
    ['maxCpuMillicores', 100, 64_000],
    ['maxMemoryBytes', 67_108_864, 68_719_476_736],
    ['maxPids', 8, 4096],
    ['maxOutputBytes', 1024, 67_108_864],
    ['maxEvidenceBytes', 1024, 1_073_741_824],
  ] as const;

  it.each(resourceRanges)('accepts the exact %s boundaries', (field, min, max) => {
    for (const value of [min, max]) {
      const result = runValidator((config) => {
        (config.resourcePolicies[0] as unknown as Record<string, unknown>)[field] = value;
        config.resourcePolicies[0].maxProviderCredits = 0.5;
        config.profiles[0].shellPolicy = 'validation';
        config.profiles[0].gitPolicy = 'sandbox';
        config.resourcePolicies[0].modelClass = 'deep';
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    }
  });

  it.each(resourceRanges)('rejects %s outside its exact range', (field, min, max) => {
    for (const value of [min - 1, max + 1]) {
      expectRejected((config) => {
        (config.resourcePolicies[0] as unknown as Record<string, unknown>)[field] = value;
      }, `policy economy: ${field} must be an integer in range ${min}..${max}`);
    }
  });

  it.each([
    ['non-numeric', '1'],
    ['zero', 0],
    ['negative', -1],
  ])('rejects %s maxProviderCredits', (_name, value) => {
    expectRejected((config) => {
      (config.resourcePolicies[0] as unknown as Record<string, unknown>).maxProviderCredits = value;
    }, 'policy economy: maxProviderCredits must be a positive number');
  });

  it.each([
    ['backend profile', (config: AgentConfig) => { config.backends[0].profiles = ['plan']; }, 'backend ollama: unknown profile plan'],
    ['backend resource policy', (config: AgentConfig) => { config.backends[0].defaultResourcePolicy = 'standard'; }, 'backend ollama: unknown resource policy standard'],
    ['project backend', (config: AgentConfig) => { config.projects[0].backends = ['kiro']; }, 'project demo: unknown backend kiro'],
    ['project profile', (config: AgentConfig) => { config.projects[0].profiles = ['plan']; }, 'project demo: unknown profile plan'],
    ['profile resource policy', (config: AgentConfig) => { config.profiles[0].defaultResourcePolicy = 'standard'; }, 'profile audit: unknown resource policy standard'],
  ] as const)('rejects a known but undefined %s reference', (_name, mutate, message) => {
    expectRejected(mutate, message);
  });

  it.each([
    ['backend', (config: AgentConfig) => { config.backends.push({ ...config.backends[0], profiles: [...config.backends[0].profiles] }); }, 'duplicate backend id ollama'],
    ['project', (config: AgentConfig) => { config.projects.push({ ...config.projects[0], backends: [...config.projects[0].backends], profiles: [...config.projects[0].profiles] }); }, 'duplicate project id demo'],
    ['profile', (config: AgentConfig) => { config.profiles.push({ ...config.profiles[0] }); }, 'duplicate profile id audit'],
    ['resource policy', (config: AgentConfig) => { config.resourcePolicies.push({ ...config.resourcePolicies[0] }); }, 'duplicate resource policy id economy'],
  ] as const)('preserves duplicate %s id rejection', (_name, mutate, message) => {
    expectRejected(mutate, message);
  });

  it('preserves the implement-only sandbox-write invariant', () => {
    expectRejected((config) => {
      config.profiles[0].workspaceAccess = 'sandbox-write';
    }, 'profile audit: sandbox-write is reserved for writer profiles (implement)');
  });
});
