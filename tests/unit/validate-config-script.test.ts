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

describe('scripts/validate-config.mjs agent schema parity', () => {
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
});
