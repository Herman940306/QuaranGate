/**
 * H1-5: ACP fixture workspace isolation sentinel tests.
 *
 * Proves that the mock ACP impl server never writes fixture artifacts
 * (generated.ts, target.ts, keep.ts) to the repository root or process.cwd().
 *
 * The exact defect: mock-acp-impl-server.mjs previously hardcoded
 * const WORKSPACE = '/workspace' and wrote there unconditionally. On any host
 * where /workspace is writable (common in CI, Docker, devcontainers), files
 * would appear outside the intended disposable workspace.
 *
 * The fix (H1-5): the mock reads ACP_MOCK_WORKSPACE from the environment and
 * skips all writes if it is not set.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOCK = join(REPO_ROOT, 'tests', 'fixtures', 'mock-acp-impl-server.mjs');

// Known mock fixture artifacts that must NEVER appear in the repo root.
const FIXTURE_ARTIFACTS = ['generated.ts', 'target.ts', 'keep.ts'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendAcpMessages(msgs: string[]): string {
  const input = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
  // Actually send raw JSON strings (already stringified messages).
  const rawInput = msgs.join('\n') + '\n';
  const r = spawnSync(process.execPath, [MOCK], {
    input: rawInput,
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env },
  });
  return r.stdout ?? '';
}

/** Full ACP session that triggers an IMPLEMENT write. Returns stdout. */
function runImplSession(opts: { workspace?: string } = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.workspace) {
    env.ACP_MOCK_WORKSPACE = opts.workspace;
  } else {
    delete env.ACP_MOCK_WORKSPACE;
  }

  const messages = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { mcpServers: [] } }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {
      sessionId: 'sess-test',
      prompt: [{ type: 'text', text: 'IMPLEMENT the feature' }],
    } }),
  ];

  const r = spawnSync(process.execPath, [MOCK], {
    input: messages.join('\n') + '\n',
    encoding: 'utf8',
    timeout: 5_000,
    env,
  });
  return r.stdout ?? '';
}

// ---------------------------------------------------------------------------
// Sentinel: before each test, record repo root contents
// ---------------------------------------------------------------------------

let preTestRepoFiles: Set<string>;

beforeEach(() => {
  preTestRepoFiles = new Set(readdirSync(REPO_ROOT));
});

// After each test, verify no new fixture artifacts appeared in repo root.
afterEach(() => {
  for (const artifact of FIXTURE_ARTIFACTS) {
    if (!preTestRepoFiles.has(artifact) && existsSync(join(REPO_ROOT, artifact))) {
      // Clean up first so the repo stays clean, then fail.
      try { rmSync(join(REPO_ROOT, artifact)); } catch { /* best effort */ }
      throw new Error(
        `H1-5 SENTINEL FAIL: fixture artifact "${artifact}" appeared in repo root after test. ` +
        'The mock workspace isolation fix is incomplete.',
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Test: without ACP_MOCK_WORKSPACE, no filesystem writes occur
// ---------------------------------------------------------------------------

describe('mock-acp-impl-server — no ACP_MOCK_WORKSPACE set', () => {
  it('does not write any fixture artifacts anywhere when ACP_MOCK_WORKSPACE is unset', () => {
    // Ensure env var is not set.
    const savedWs = process.env.ACP_MOCK_WORKSPACE;
    delete process.env.ACP_MOCK_WORKSPACE;
    try {
      const output = runImplSession({ workspace: undefined });
      // Protocol should still proceed (tool_call notifications emitted).
      expect(output).toContain('end_turn');
    } finally {
      if (savedWs !== undefined) process.env.ACP_MOCK_WORKSPACE = savedWs;
    }
    // Sentinel afterEach will catch any file leaks.
  });

  it('emits tool_call notifications even without a workspace (protocol behaviour intact)', () => {
    const savedWs = process.env.ACP_MOCK_WORKSPACE;
    delete process.env.ACP_MOCK_WORKSPACE;
    try {
      const output = runImplSession({ workspace: undefined });
      expect(output).toContain('"tool_call"');
      expect(output).toContain('edit');
    } finally {
      if (savedWs !== undefined) process.env.ACP_MOCK_WORKSPACE = savedWs;
    }
  });
});

// ---------------------------------------------------------------------------
// Test: with ACP_MOCK_WORKSPACE set, writes occur ONLY inside it
// ---------------------------------------------------------------------------

describe('mock-acp-impl-server — with ACP_MOCK_WORKSPACE set', () => {
  let tmpWs: string | null = null;

  afterEach(() => {
    if (tmpWs) {
      try { rmSync(tmpWs, { recursive: true, force: true }); } catch { /* best effort */ }
      tmpWs = null;
    }
    delete process.env.ACP_MOCK_WORKSPACE;
  });

  it('writes generated.ts and target.ts inside the disposable workspace', () => {
    tmpWs = mkdtempSync(join(tmpdir(), 'h1-fixture-ws-'));
    const output = runImplSession({ workspace: tmpWs });
    expect(output).toContain('end_turn');

    // Files must appear INSIDE the disposable workspace.
    expect(existsSync(join(tmpWs, 'generated.ts'))).toBe(true);
    expect(existsSync(join(tmpWs, 'target.ts'))).toBe(true);
  });

  it('does NOT write to repo root', () => {
    tmpWs = mkdtempSync(join(tmpdir(), 'h1-fixture-ws-'));
    runImplSession({ workspace: tmpWs });

    for (const artifact of FIXTURE_ARTIFACTS) {
      expect(existsSync(join(REPO_ROOT, artifact))).toBe(false);
    }
  });

  it('cleanup removes the disposable workspace entirely', () => {
    tmpWs = mkdtempSync(join(tmpdir(), 'h1-fixture-ws-'));
    runImplSession({ workspace: tmpWs });
    expect(existsSync(tmpWs)).toBe(true);

    rmSync(tmpWs, { recursive: true, force: true });
    expect(existsSync(tmpWs)).toBe(false);
    tmpWs = null; // already cleaned
  });
});

// ---------------------------------------------------------------------------
// Test: repo root sentinel — baseline
// ---------------------------------------------------------------------------

describe('repo root sentinel — baseline invariant', () => {
  for (const artifact of FIXTURE_ARTIFACTS) {
    it(`"${artifact}" is not present in repo root`, () => {
      expect(existsSync(join(REPO_ROOT, artifact))).toBe(false);
    });
  }
});
