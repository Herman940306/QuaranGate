/**
 * Runner-internal ACP driver entrypoint — Phase A4.
 *
 * This module runs INSIDE the hardened Kiro runner container (as
 * `node /run/control/executor/agents/runnerMain.js`), NOT in the Executor. It
 * is the piece that removes the need for an interactive `docker run -i` attach:
 * the Executor launches the runner purely through the Docker Engine API
 * (create → start → wait → logs), and THIS process drives the ACP JSON-RPC turn
 * locally over the kiro-cli child's stdin/stdout.
 *
 * It REUSES the exact same {@link AcpDriver} the rest of A4 is built on (no
 * second, divergent ACP implementation). The driver is launch-agnostic, so here
 * it simply spawns `kiro-cli acp …` as a sibling child process.
 *
 * Trust + safety:
 *   - The control data ({@link RunnerControl}) is produced ONLY by trusted
 *     Executor code and delivered on a READ-ONLY job-scoped volume. It never
 *     contains the API key (the key is exported by the image entrypoint from
 *     the RO secret file and inherited via the process environment).
 *   - Exactly ONE line is written to stdout — the {@link RESULT_MARKER}-prefixed
 *     bounded normalized result. Everything else (diagnostics) goes to stderr,
 *     so the container logs the Executor consumes stay clean and bounded.
 *   - `dryRun` stops the sequence after `session/new` (no prompt, no model
 *     inference) — used by the production-execution gate and as a health probe.
 */
import { readFileSync } from 'node:fs';
import { AcpDriver, ACP_TRUST_TOOLS_FLAG } from './acpDriver.js';

/** Sentinel that prefixes the single normalized result line on stdout. */
export const RESULT_MARKER = '__ACP_RESULT__';

/** Trusted, Executor-produced control data. NEVER contains the API key. */
export interface RunnerControl {
  /** Bridge-owned per-job agent name (unguessable). */
  agent: string;
  /** Concrete model id passed to startup `--model`. */
  model: string;
  /** Comma-separated trusted tools (read,grep,glob). */
  trustTools?: string;
  /** Working directory for the ACP session (the RO /workspace). */
  cwd: string;
  /** The analysis prompt (only sent when !dryRun). */
  prompt: string;
  /** Stop after session/new (no prompt, no inference). */
  dryRun: boolean;
  /** Max time for a full prompt turn. */
  promptTimeoutMs?: number;
  /** Bound on captured assistant text. */
  maxAssistantBytes?: number;
  /**
   * Trusted launch seam. Production omits these (defaults to the real CLI);
   * deterministic tests point them at a mock ACP server. Because control data
   * is trusted Executor output, this is never caller-influenced.
   */
  acpCommand?: string;
  acpPrefixArgs?: string[];
}

/** Bounded, normalized result the Executor parses from the container logs. */
export interface RunnerResult {
  ok: boolean;
  dryRun: boolean;
  protocolVersion?: number;
  agentInfo?: { name: string; version: string };
  kiroVersion?: string;
  sessionId?: string;
  models?: unknown;
  modes?: unknown;
  /**
   * Bounded tool-call OUTCOME evidence, aggregated by (kind, status). The
   * `status` is the ACP terminal tool status (completed/failed/…) — carried
   * across the runner boundary so the Executor can tell a SUCCESSFUL mutation
   * from one that was CALLED but failed/denied (A5 result-semantics fix).
   */
  toolCalls: { kind: string; status?: string; count: number }[];
  assistantText: string;
  stopReason: string;
  refusedRequestCount: number;
  error?: string;
  stderrTail?: string;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ASSISTANT_BYTES = 16 * 1024;

/**
 * Drive one ACP job to at most a single completed turn (or stop after
 * session/new when dryRun). Pure of process concerns so it is unit-testable
 * against a mock ACP server.
 */
export async function runAcpJob(control: RunnerControl): Promise<RunnerResult> {
  const driver = new AcpDriver({
    command: control.acpCommand ?? 'kiro-cli',
    commandPrefixArgs: control.acpPrefixArgs ?? [],
    cwd: control.cwd,
    // The runner container's environment already carries the isolated
    // HOME/KIRO_HOME/XDG, the proxy vars, and KIRO_API_KEY (exported by the
    // entrypoint from the RO secret file). Pass it through unchanged.
    env: process.env as Record<string, string>,
    agent: control.agent,
    trustTools: control.trustTools ?? ACP_TRUST_TOOLS_FLAG,
    model: control.model,
  });

  const base: RunnerResult = {
    ok: false,
    dryRun: Boolean(control.dryRun),
    toolCalls: [],
    assistantText: '',
    stopReason: 'error',
    refusedRequestCount: 0,
  };

  // The driver re-emits 'error' on a spawn failure; without a listener Node
  // would treat it as an unhandled 'error' event and crash the process. We
  // observe it as a normal rejection of the pending request instead.
  driver.on('error', () => { /* surfaced via the awaited request rejection */ });

  driver.spawn();
  try {
    const init = await driver.initialize();
    base.protocolVersion = init.protocolVersion;
    base.agentInfo = init.agentInfo ? { name: init.agentInfo.name, version: init.agentInfo.version } : undefined;
    base.kiroVersion = init.agentInfo?.version;

    const session = await driver.sessionNew(control.cwd);
    base.sessionId = session.sessionId;
    base.models = session.models;
    base.modes = session.modes;

    if (control.dryRun || !control.prompt) {
      base.ok = true;
      base.stopReason = 'dry_run';
      base.refusedRequestCount = driver.getRefusedRequestCount();
      return base;
    }

    const turn = await driver.prompt({
      prompt: control.prompt,
      timeoutMs: control.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
    });

    // Aggregate by (kind, status) so counts are preserved AND a failed mutation
    // is not collapsed into a same-kind successful one. A write tool that was
    // CALLED but ended `failed` therefore survives as its own bounded entry.
    const counts = new Map<string, { kind: string; status?: string; count: number }>();
    for (const tc of turn.toolCalls) {
      const key = `${tc.kind}\u0000${tc.status ?? ''}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { kind: tc.kind, status: tc.status, count: 1 });
    }

    base.ok = true;
    base.toolCalls = [...counts.values()];
    base.assistantText = turn.assistantText.slice(0, control.maxAssistantBytes ?? DEFAULT_MAX_ASSISTANT_BYTES);
    base.stopReason = turn.stopReason;
    base.refusedRequestCount = driver.getRefusedRequestCount();
    return base;
  } catch (e) {
    base.ok = false;
    base.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    base.stderrTail = driver.getStderr().slice(-2000);
    base.refusedRequestCount = driver.getRefusedRequestCount();
    return base;
  } finally {
    await driver.shutdown().catch(() => {});
  }
}

/** Read control, run the job, and emit exactly one result line. */
async function main(): Promise<void> {
  const controlPath = process.argv[2] ?? '/run/control/control.json';
  let control: RunnerControl;
  try {
    control = JSON.parse(readFileSync(controlPath, 'utf8')) as RunnerControl;
  } catch (e) {
    process.stdout.write(`${RESULT_MARKER}${JSON.stringify({
      ok: false, dryRun: false, toolCalls: [], assistantText: '', stopReason: 'error',
      refusedRequestCount: 0, error: `failed to read control: ${(e as Error).message}`,
    } satisfies RunnerResult)}\n`);
    process.exit(1);
    return;
  }
  const result = await runAcpJob(control);
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

// Only run as a process entrypoint when invoked directly (not when imported by
// a test). The runner launches `node …/runnerMain.js`.
const invoked = process.argv[1] ?? '';
if (invoked.endsWith('runnerMain.js') || invoked.endsWith('runnerMain.ts')) {
  void main();
}
