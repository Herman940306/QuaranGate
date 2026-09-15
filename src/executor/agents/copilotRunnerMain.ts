/** Runner-internal, bounded GitHub Copilot CLI ACP client. */
import { readFileSync } from 'node:fs';
import { AcpDriver } from './acpDriver.js';

export const COPILOT_RESULT_MARKER = '__COPILOT_ACP_RESULT__';
export const COPILOT_READONLY_TOOLS = ['view', 'grep', 'glob'] as const;

export interface CopilotRunnerControl {
  model: string;
  cwd: string;
  prompt: string;
  dryRun: boolean;
  promptTimeoutMs?: number;
  maxAssistantBytes?: number;
  acpCommand?: string;
  acpPrefixArgs?: string[];
}

export interface CopilotRunnerResult {
  ok: boolean;
  dryRun: boolean;
  protocolVersion?: number;
  agentInfo?: { name: string; version: string };
  sessionId?: string;
  toolCalls: { kind: string; status?: string; count: number }[];
  assistantText: string;
  stopReason: string;
  refusedRequestCount: number;
  error?: string;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ASSISTANT_BYTES = 16 * 1024;

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

/** Exact trusted CLI policy. No caller field reaches this argv. */
export function buildCopilotAcpArgs(model: string): string[] {
  return [
    '--acp',
    '--stdio',
    '--model', model,
    `--available-tools=${COPILOT_READONLY_TOOLS.join(',')}`,
    '--allow-tool=read',
    '--deny-tool=write',
    '--deny-tool=shell',
    '--deny-tool=url',
    '--deny-tool=memory',
    '--disable-builtin-mcps',
    '--no-custom-instructions',
    '--no-remote',
    '--no-remote-export',
    '--no-auto-update',
    '--no-ask-user',
    '--disallow-temp-dir',
    '--no-bash-env',
    '--no-experimental',
    '--no-color',
    '--log-level=none',
    '--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN',
  ];
}

export async function runCopilotAcpJob(control: CopilotRunnerControl): Promise<CopilotRunnerResult> {
  const driver = new AcpDriver({
    command: control.acpCommand ?? 'copilot',
    commandPrefixArgs: control.acpPrefixArgs ?? [],
    cwd: control.cwd,
    env: process.env as Record<string, string>,
    agent: '',
    trustTools: '',
    model: control.model,
    acpArgs: buildCopilotAcpArgs(control.model),
    processLabel: 'copilot',
  });
  const result: CopilotRunnerResult = {
    ok: false,
    dryRun: Boolean(control.dryRun),
    toolCalls: [],
    assistantText: '',
    stopReason: 'error',
    refusedRequestCount: 0,
  };
  driver.on('error', () => {});
  let stage: 'spawn' | 'initialize' | 'session' | 'prompt' = 'spawn';
  driver.spawn();
  try {
    stage = 'initialize';
    const init = await driver.initialize();
    result.protocolVersion = init.protocolVersion;
    if (init.agentInfo) result.agentInfo = { name: init.agentInfo.name, version: init.agentInfo.version };
    stage = 'session';
    const session = await driver.sessionNew(control.cwd);
    result.sessionId = session.sessionId;
    if (control.dryRun || !control.prompt) {
      result.ok = true;
      result.stopReason = 'dry_run';
      return result;
    }
    stage = 'prompt';
    const turn = await driver.prompt({
      prompt: control.prompt,
      timeoutMs: control.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
    });
    const counts = new Map<string, { kind: string; status?: string; count: number }>();
    for (const toolCall of turn.toolCalls) {
      const key = `${toolCall.kind}\0${toolCall.status ?? ''}`;
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { kind: toolCall.kind, status: toolCall.status, count: 1 });
    }
    result.ok = true;
    result.toolCalls = [...counts.values()];
    result.assistantText = truncateUtf8(
      turn.assistantText,
      control.maxAssistantBytes ?? DEFAULT_MAX_ASSISTANT_BYTES,
    );
    result.stopReason = turn.stopReason;
    return result;
  } catch {
    // Deliberately omit raw provider stderr/protocol state from result.
    result.error = `Copilot ACP ${stage} failed`;
    return result;
  } finally {
    result.refusedRequestCount = driver.getRefusedRequestCount();
    await driver.shutdown().catch(() => {});
  }
}

async function main(): Promise<void> {
  const controlPath = process.argv[2] ?? '/run/control/control.json';
  let control: CopilotRunnerControl;
  try {
    control = JSON.parse(readFileSync(controlPath, 'utf8')) as CopilotRunnerControl;
  } catch {
    process.stdout.write(`${COPILOT_RESULT_MARKER}${JSON.stringify({
      ok: false,
      dryRun: false,
      toolCalls: [],
      assistantText: '',
      stopReason: 'error',
      refusedRequestCount: 0,
      error: 'failed to read trusted Copilot control',
    } satisfies CopilotRunnerResult)}\n`);
    process.exit(1);
    return;
  }
  const result = await runCopilotAcpJob(control);
  process.stdout.write(`${COPILOT_RESULT_MARKER}${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('copilotRunnerMain.js') || invoked.endsWith('copilotRunnerMain.ts')) {
  void main();
}
