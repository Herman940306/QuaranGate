/**
 * A4 agent-policy tests — the bridge-owned read-only agent, the agent-override
 * mitigation (unguessable per-job name), and the runner image invariants.
 *
 * NOTE: this replaces the earlier, DISPROVEN assumption that `--trust-tools`
 * alone contains a hostile workspace agent. The real mitigation is that the
 * bridge agent's name is per-job and unguessable, so a staged/tracked project
 * cannot ship a same-named `.kiro/agents/<name>.json` that Kiro would resolve
 * ahead of the bridge agent (Critical Finding #1). `--trust-tools` and the
 * driver's fail-closed request handling are additional layers, not the primary
 * boundary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ACP_TRUST_TOOLS_FLAG, ACP_AGENT_NAME_PATTERN, newBridgeAgentName,
} from '../../src/executor/agents/acpDriver.js';
import { bridgeAgentConfig } from '../../src/executor/agents/kiroBackend.js';
import { RUNNER_SECRET_PATH } from '../../src/executor/agents/credentialManager.js';

const RUNNER_DIR = resolve(import.meta.dirname, '../../runner/kiro');

describe('bridge agent config (per-job)', () => {
  const name = newBridgeAgentName(() => randomBytes(16).toString('hex'));
  const cfg = bridgeAgentConfig(name);

  it('uses the unguessable per-job name', () => {
    expect(cfg.name).toBe(name);
    expect(ACP_AGENT_NAME_PATTERN.test(String(cfg.name))).toBe(true);
  });

  it('restricts available tools to read/grep/glob with no wildcard', () => {
    expect(cfg.tools).toEqual(['read', 'grep', 'glob']);
    expect(JSON.stringify(cfg.tools)).not.toContain('*');
  });

  it('disables MCP: empty mcpServers and includeMcpJson=false', () => {
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.includeMcpJson).toBe(false);
  });

  it('has no hooks, no resources, no fixed model', () => {
    expect(cfg.hooks).toEqual({});
    expect(cfg.resources).toEqual([]);
    expect(cfg.model).toBeNull();
  });

  it('--trust-tools matches the available tool set (defense in depth)', () => {
    expect(ACP_TRUST_TOOLS_FLAG.split(',')).toEqual(cfg.tools);
  });
});

describe('agent-override mitigation', () => {
  it('per-job names are unguessable and unique, so a workspace same-name file cannot match', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const n = newBridgeAgentName(() => randomBytes(16).toString('hex'));
      expect(ACP_AGENT_NAME_PATTERN.test(n)).toBe(true);
      seen.add(n);
    }
    expect(seen.size).toBe(100);
    // The static, guessable name that a hostile workspace could pre-stage is
    // NOT what the backend selects at run time.
    expect([...seen].every((n) => n !== 'bridge_readonly')).toBe(true);
  });
});

describe('reference template runner/kiro/bridge-readonly.json', () => {
  const cfg = JSON.parse(readFileSync(resolve(RUNNER_DIR, 'bridge-readonly.json'), 'utf8'));
  it('exists and locks the same security-relevant fields', () => {
    expect(cfg.tools).toEqual(['read', 'grep', 'glob']);
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.includeMcpJson).toBe(false);
    expect(cfg.hooks).toEqual({});
    expect(cfg.model).toBeNull();
  });
  it('documents that it is a template overridden by an unguessable per-job name', () => {
    expect(cfg.description).toMatch(/unguessable|per-job/i);
  });
});

describe('runner Dockerfile invariants', () => {
  const dockerfile = readFileSync(resolve(RUNNER_DIR, 'Dockerfile'), 'utf8');

  it('runs non-root and isolates HOME/KIRO_HOME/XDG', () => {
    expect(dockerfile).toContain('USER 1000:1000');
    expect(dockerfile).toContain('HOME=/home/runner');
    expect(dockerfile).toContain('KIRO_HOME=/home/runner/.kiro');
    expect(dockerfile).toContain('XDG_CONFIG_HOME=/home/runner/.config');
    expect(dockerfile).toContain('XDG_STATE_HOME=/home/runner/.local/state');
  });

  it('disables telemetry + auto-update', () => {
    expect(dockerfile).toContain('KIRO_TELEMETRY=off');
    expect(dockerfile).toContain('KIRO_DISABLE_UPDATE=1');
  });

  it('bakes NO fixed-name agent config (per-job home volume supplies it)', () => {
    expect(dockerfile).not.toMatch(/COPY.*bridge-readonly\.json/);
    expect(dockerfile).not.toMatch(/COPY.*\.kiro\/agents/);
  });

  it('loads the credential via a RO secret-file entrypoint, never a baked key or Env', () => {
    expect(dockerfile).toContain('kiro-acp-entrypoint');
    expect(dockerfile).not.toContain('KIRO_API_KEY=');
  });

  it('never uses --trust-all-tools / --yolo / docker.sock', () => {
    expect(dockerfile).not.toContain('--trust-all-tools');
    expect(dockerfile).not.toContain('--yolo');
    expect(dockerfile).not.toMatch(/docker\.sock/);
  });

  it('creates /run/secrets 0700', () => {
    expect(dockerfile).toContain('/run/secrets');
    expect(dockerfile).toContain('chmod 0700 /run/secrets');
  });
});

describe('entrypoint script', () => {
  const ep = readFileSync(resolve(RUNNER_DIR, 'kiro-acp-entrypoint.sh'), 'utf8');
  it('reads the key from the RO secret file and exec\'s the trusted command', () => {
    expect(ep).toContain('/run/secrets/kiro-api-key');
    expect(ep).toContain('export KIRO_API_KEY');
    expect(ep).toMatch(/exec "\$@"/);
  });
  it('does not echo/log the key', () => {
    expect(ep).not.toMatch(/echo .*KIRO_API_KEY/);
  });
});

describe('credential secret path', () => {
  it('is under /run/secrets, not /workspace or a home dir', () => {
    expect(existsSync).toBeTruthy();
    expect(RUNNER_SECRET_PATH).toBe('/run/secrets/kiro-api-key');
    expect(RUNNER_SECRET_PATH).not.toContain('/workspace');
    expect(RUNNER_SECRET_PATH).not.toContain('/home');
  });
});
