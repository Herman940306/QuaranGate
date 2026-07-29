/**
 * Kiro ACP (Agent Client Protocol) Driver — Phase A4.
 *
 * Minimal production driver that speaks newline-delimited JSON-RPC 2.0 over a
 * child process's stdin/stdout to a trusted `kiro-cli acp` process. The message
 * shapes here match the shapes VALIDATED LIVE against Kiro CLI 2.5.0 (see the
 * `a4-kiro-acp-runtime-facts` audit note), NOT guesses:
 *
 *   - initialize        params {protocolVersion:1, clientCapabilities:{}}
 *   - session/new       params {cwd, mcpServers:[]}            -> {sessionId, models?}
 *   - session/prompt    params {sessionId, prompt:[{type:"text",text}]} -> {stopReason}
 *   - session/cancel    NOTIFICATION params {sessionId}        (no response)
 *   - progress arrives as `session/update` notifications:
 *        update.sessionUpdate == "agent_message_chunk" -> content.text
 *        update.sessionUpdate == "tool_call" / "tool_call_update" -> kind/title/status
 *
 * Model selection is done with the startup `--model` flag (proven by
 * `kiro-cli acp --help`), NEVER as a session/prompt field.
 *
 * The driver is launch-agnostic: it spawns `command` with `commandPrefixArgs`
 * followed by the ACP argv. This lets the SAME driver run kiro-cli directly on
 * a trusted host OR inside a hardened container via `docker run -i …`.
 *
 * Security invariants:
 *   - Available tools come from the bridge-owned `--agent` (read,grep,glob);
 *     `--trust-tools` additionally limits auto-approval. NEVER --trust-all-tools.
 *   - mcpServers always [] in session/new.
 *   - Incoming server->client REQUESTS (fs/*, terminal/*, permission, …) fail
 *     closed: they are answered with a JSON-RPC error, never fulfilled, so a
 *     hostile agent turn cannot obtain write/shell/mcp/web capability and cannot
 *     hang the turn waiting for a grant.
 *   - Known `_kiro.dev/*` extension notifications are tolerated, never acted on.
 *   - Protocol/stderr buffers are bounded to prevent memory exhaustion.
 *   - No raw wire traffic is logged; KIRO_ACP_RECORD_PATH is never set here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { BridgeError } from '../../shared/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 message shapes for the ACP protocol. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/** ACP initialize result (subset we consume). */
export interface AcpInitResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: unknown[];
  agentInfo?: { name: string; title?: string; version: string };
}

/** ACP session/new result. */
export interface AcpSessionResult {
  sessionId: string;
  models?: unknown;
  modes?: unknown;
}

/** A tool call observed during a prompt turn. */
export interface AcpToolCall {
  /** ACP tool kind (e.g. "read", "search"), when reported. */
  kind: string;
  /** Human title, when reported. */
  title?: string;
  /** Last reported status (pending/in_progress/completed/failed). */
  status?: string;
}

/** Result of a completed prompt turn. */
export interface AcpTurnResult {
  sessionId: string;
  assistantText: string;
  toolCalls: AcpToolCall[];
  stopReason: string;
}

/** Options for spawning the ACP driver. */
export interface AcpDriverOptions {
  /** Executable to spawn (kiro-cli path, or `docker` for a containerised launch). */
  command: string;
  /**
   * Argv inserted BEFORE the acp arguments. For a direct host launch this is
   * empty; for a container launch it is the `run -i …hardened flags… image
   * kiro-cli` prefix. Never caller-controlled — built from trusted policy.
   */
  commandPrefixArgs?: string[];
  /** Working directory for the spawned process (the docker CLI / host kiro-cli). */
  cwd: string;
  /** Environment for the spawned process. */
  env: Record<string, string>;
  /** Bridge-owned agent name (unguessable per job — see newBridgeAgentName). */
  agent: string;
  /** Comma-separated trusted tools (read,grep,glob). */
  trustTools: string;
  /** Concrete model id passed to startup `--model`. */
  model: string;
  /** Extra acp flags appended verbatim (trusted; e.g. `--agent-engine v2`). */
  extraAcpArgs?: string[];
  maxProtocolBytes?: number;
  maxStderrBytes?: number;
}

/** Options for sending a prompt. */
export interface AcpPromptOptions {
  prompt: string;
  signal?: AbortSignal;
  /** Maximum time (ms) to wait for a complete turn. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PROTOCOL_BYTES = 16 * 1024 * 1024; // 16 MiB
const DEFAULT_MAX_STDERR_BYTES = 1 * 1024 * 1024; // 1 MiB
const INITIALIZE_TIMEOUT_MS = 30_000;
const SESSION_NEW_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;
const MAX_ASSISTANT_TEXT_BYTES = 256 * 1024;
const MAX_TOOL_CALLS = 512;

/** ACP protocol version validated live against Kiro 2.5.0. */
export const ACP_PROTOCOL_VERSION = 1;

/** Known Kiro extension / notification prefixes that are safe to ignore. */
const KNOWN_EXTENSION_PREFIXES = ['_kiro.dev/', 'kiro.dev/'];

/**
 * Server->client request method prefixes we refuse. These would grant the agent
 * privileged capability (filesystem writes, shell, MCP, web, delegation). We
 * answer them with a JSON-RPC error to fail closed WITHOUT hanging the turn.
 */
const PRIVILEGED_REQUEST_PREFIXES = [
  'fs/', 'file/', 'shell/', 'terminal/', 'workspace/edit', 'mcp/', 'tools/call',
  'web/', 'net/', 'exec/', 'process/', 'session/delegate', 'subagent/',
];

// ---------------------------------------------------------------------------
// ACP Driver
// ---------------------------------------------------------------------------

export class AcpDriver extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  private protocolBuffer = '';
  private protocolBytes = 0;
  private stderrBuffer = '';
  private stderrBytes = 0;
  private readonly maxProtocolBytes: number;
  private readonly maxStderrBytes: number;
  private initialized = false;
  private sessionId: string | null = null;
  private dead = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;

  /** Tool calls observed during the current prompt turn, keyed by toolCallId. */
  private currentToolCalls = new Map<string, AcpToolCall>();
  private currentToolCallOrder: string[] = [];
  private currentAssistantText = '';
  /** Count of privileged server->client requests refused (for evidence/tests). */
  private refusedRequestCount = 0;

  constructor(private readonly opts: AcpDriverOptions) {
    super();
    this.maxProtocolBytes = opts.maxProtocolBytes ?? DEFAULT_MAX_PROTOCOL_BYTES;
    this.maxStderrBytes = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  }

  /** Build the exact acp argv (deterministic; unit-testable without spawning). */
  buildArgs(): string[] {
    return [
      ...(this.opts.commandPrefixArgs ?? []),
      'acp',
      '--agent', this.opts.agent,
      '--model', this.opts.model,
      '--trust-tools', this.opts.trustTools,
      ...(this.opts.extraAcpArgs ?? []),
    ];
  }

  /** Spawn the process. Does NOT initialize — call initialize() after. */
  spawn(): void {
    if (this.proc) throw new BridgeError('SANDBOX_FAILED', 'ACP driver already spawned', 500);

    this.proc = spawn(this.opts.command, this.buildArgs(), {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr!.on('data', (chunk: Buffer) => this.onStderr(chunk));
    this.proc.stdin!.on('error', () => { /* broken pipe on child exit — ignore */ });
    this.proc.on('exit', (code, signal) => {
      this.dead = true;
      this.exitCode = code;
      this.exitSignal = signal as string | null;
      this.rejectAllPending(new Error(`kiro-cli exited (code=${code}, signal=${signal})`));
      this.emit('exit', code, signal);
    });
    this.proc.on('error', (err) => {
      this.dead = true;
      this.rejectAllPending(err);
      this.emit('error', err);
    });
  }

  /** Send initialize and verify the negotiated protocol version. */
  async initialize(): Promise<AcpInitResult> {
    this.assertAlive();
    // Always advertise no client filesystem capability. Kiro performs its
    // file mutations IN-PROCESS against its own cwd (the writable /workspace
    // volume). No server->client fs/* delegation is ever needed, and the
    // fail-closed request backstop below remains fully intact for every profile.
    const result = await this.sendRequest('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
    }, INITIALIZE_TIMEOUT_MS) as AcpInitResult;

    if (typeof result?.protocolVersion !== 'number') {
      throw new BridgeError('SANDBOX_FAILED', 'ACP initialize: missing protocolVersion', 500);
    }
    this.initialized = true;
    return result;
  }

  /** Create a new session with controlled parameters (no MCP servers, ever). */
  async sessionNew(cwd: string): Promise<AcpSessionResult> {
    this.assertInitialized();
    const result = await this.sendRequest('session/new', {
      cwd,
      mcpServers: [], // NEVER allow workspace MCP servers
    }, SESSION_NEW_TIMEOUT_MS) as AcpSessionResult;

    if (!result?.sessionId) {
      throw new BridgeError('SANDBOX_FAILED', 'ACP session/new: missing sessionId', 500);
    }
    this.sessionId = result.sessionId;
    return result;
  }

  /** Send a prompt and wait for the turn to complete (stopReason). */
  async prompt(opts: AcpPromptOptions): Promise<AcpTurnResult> {
    this.assertInitialized();
    if (!this.sessionId) {
      throw new BridgeError('SANDBOX_FAILED', 'ACP prompt: no active session', 500);
    }

    this.currentToolCalls = new Map();
    this.currentToolCallOrder = [];
    this.currentAssistantText = '';

    const timeoutMs = opts.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;

    if (opts.signal?.aborted) {
      throw new BridgeError('SANDBOX_FAILED', 'ACP prompt: already aborted', 500);
    }
    const abortHandler = () => { void this.cancelSession().finally(() => this.kill('prompt cancelled')); };
    if (opts.signal) opts.signal.addEventListener('abort', abortHandler, { once: true });

    try {
      const result = await this.sendRequest('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: opts.prompt }],
      }, timeoutMs) as Record<string, unknown>;

      const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn';

      return {
        sessionId: this.sessionId!,
        assistantText: this.currentAssistantText.slice(0, MAX_ASSISTANT_TEXT_BYTES),
        toolCalls: this.currentToolCallOrder.map((id) => this.currentToolCalls.get(id)!),
        stopReason,
      };
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', abortHandler);
    }
  }

  /** Cancel the active session (ACP notification — no response expected). */
  async cancelSession(): Promise<void> {
    if (!this.sessionId || this.dead || !this.proc) return;
    try {
      this.sendNotification('session/cancel', { sessionId: this.sessionId });
    } catch {
      /* best effort — the process may already be gone */
    }
  }

  getSessionId(): string | null { return this.sessionId; }
  getStderr(): string { return this.stderrBuffer; }
  getRefusedRequestCount(): number { return this.refusedRequestCount; }
  isAlive(): boolean { return !this.dead && this.proc !== null; }

  /** Gracefully terminate: close stdin, wait briefly, then SIGKILL. */
  async shutdown(): Promise<void> {
    if (this.dead || !this.proc) return;
    try { this.proc.stdin!.end(); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.proc?.kill('SIGKILL'); resolve(); }, 5000);
      this.proc!.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  /** Force kill immediately. */
  kill(reason?: string): void {
    if (this.dead || !this.proc) return;
    this.dead = true;
    try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
    this.rejectAllPending(new Error(reason ?? 'ACP driver killed'));
  }

  // -------------------------------------------------------------------------
  // Private: protocol handling
  // -------------------------------------------------------------------------

  private assertAlive(): void {
    if (this.dead || !this.proc) {
      throw new BridgeError('SANDBOX_FAILED',
        `ACP process not alive (exitCode=${this.exitCode}, signal=${this.exitSignal})`, 500);
    }
  }

  private assertInitialized(): void {
    this.assertAlive();
    if (!this.initialized) {
      throw new BridgeError('SANDBOX_FAILED', 'ACP driver not initialized', 500);
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.assertAlive();
      const id = this.nextId++;
      this.writeLine({ jsonrpc: '2.0', id, method, params });
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new BridgeError('SANDBOX_FAILED', `ACP request ${method} timed out after ${timeoutMs}ms`, 500));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.writeLine({ jsonrpc: '2.0', method, params });
  }

  /** Answer a server->client request (used only to fail closed). */
  private sendResponse(id: number | string, body: { result?: unknown; error?: { code: number; message: string } }): void {
    this.writeLine({ jsonrpc: '2.0', id, ...body });
  }

  private writeLine(obj: Record<string, unknown>): void {
    if (this.dead || !this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n', (err) => {
      if (err) this.emit('write_error', err);
    });
  }

  private onStdout(chunk: Buffer): void {
    this.protocolBytes += chunk.length;
    if (this.protocolBytes > this.maxProtocolBytes) {
      this.kill('protocol buffer exceeded maximum size');
      return;
    }
    this.protocolBuffer += chunk.toString('utf8');
    this.processProtocolBuffer();
  }

  private onStderr(chunk: Buffer): void {
    if (this.stderrBytes >= this.maxStderrBytes) return;
    const remaining = this.maxStderrBytes - this.stderrBytes;
    const text = chunk.toString('utf8');
    this.stderrBuffer += text.slice(0, remaining);
    this.stderrBytes += chunk.length;
  }

  private processProtocolBuffer(): void {
    for (;;) {
      const nlIdx = this.protocolBuffer.indexOf('\n');
      if (nlIdx === -1) break;
      const line = this.protocolBuffer.slice(0, nlIdx).trim();
      this.protocolBuffer = this.protocolBuffer.slice(nlIdx + 1);
      if (!line) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        // Non-JSON output (e.g. a stray log line) — ignore.
        continue;
      }
      if (msg.jsonrpc !== '2.0') continue;
      this.handleMessage(msg);
    }
  }

  /**
   * Classify by presence of `method` FIRST (a JSON-RPC request/notification
   * always has `method`; a response never does). This avoids misclassifying a
   * server-initiated request — which carries BOTH id and method — as a response.
   */
  private handleMessage(msg: Record<string, unknown>): void {
    const hasMethod = typeof msg.method === 'string';
    const hasId = msg.id !== undefined && msg.id !== null;

    if (!hasMethod && hasId) {
      this.handleResponse(msg as unknown as JsonRpcResponse);
      return;
    }
    if (hasMethod && hasId) {
      // Server -> client REQUEST.
      this.handleServerRequest(
        msg.method as string,
        msg.id as number | string,
        msg.params as Record<string, unknown> | undefined,
      );
      return;
    }
    if (hasMethod) {
      this.handleNotification(msg as unknown as JsonRpcNotification);
      return;
    }
    // Neither method nor id — malformed; ignore.
  }

  private handleResponse(resp: JsonRpcResponse): void {
    const id = resp.id;
    if (typeof id !== 'number') return; // we only ever issue numeric ids
    const pending = this.pendingRequests.get(id);
    if (!pending) return; // unknown / already-settled id — ignore
    this.pendingRequests.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (resp.error) {
      pending.reject(new BridgeError('SANDBOX_FAILED',
        `ACP error (${resp.error.code}): ${resp.error.message}`, 500));
    } else {
      pending.resolve(resp.result);
    }
  }

  /**
   * A server-initiated request. We NEVER grant privileged capability. Any
   * server->client request (fs/*, terminal/*, permission, …) is answered with
   * a JSON-RPC error to fail closed WITHOUT hanging the turn.
   */
  private handleServerRequest(method: string, id: number | string, params?: Record<string, unknown>): void {
    void params; // not used — fail closed regardless of params
    this.refusedRequestCount++;
    this.emit('request_refused', method);
    this.sendResponse(id, {
      error: { code: -32601, message: `method not permitted in bridge session: ${method}` },
    });
  }

  private handleNotification(notif: JsonRpcNotification): void {
    const { method, params } = notif;

    if (method === 'session/update') {
      this.handleSessionUpdate(params);
      return;
    }
    if (KNOWN_EXTENSION_PREFIXES.some((p) => method.startsWith(p))) {
      this.emit('extension', method, params);
      return;
    }
    this.emit('unknown_notification', method, params);
  }

  /** The single progress channel in ACP: session/update with a discriminated payload. */
  private handleSessionUpdate(params: Record<string, unknown> | undefined): void {
    const update = params?.update as Record<string, unknown> | undefined;
    if (!update) return;
    const kind = update.sessionUpdate;

    if (kind === 'agent_message_chunk') {
      const content = update.content as Record<string, unknown> | undefined;
      const text = content?.type === 'text' ? content.text : undefined;
      if (typeof text === 'string' && this.currentAssistantText.length < MAX_ASSISTANT_TEXT_BYTES) {
        this.currentAssistantText += text;
      }
      return;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const idRaw = update.toolCallId ?? update.id;
      const id = typeof idRaw === 'string' ? idRaw : String(this.currentToolCallOrder.length);
      let tc = this.currentToolCalls.get(id);
      if (!tc) {
        if (this.currentToolCalls.size >= MAX_TOOL_CALLS) return; // bound accounting
        tc = { kind: typeof update.kind === 'string' ? update.kind : 'unknown' };
        this.currentToolCalls.set(id, tc);
        this.currentToolCallOrder.push(id);
      }
      if (typeof update.kind === 'string') tc.kind = update.kind;
      if (typeof update.title === 'string') tc.title = update.title;
      if (typeof update.status === 'string') tc.status = update.status;
      return;
    }

    // agent_thought_chunk, plan, available_commands_update, current_mode_update,
    // … — tolerated, not acted upon.
    this.emit('session_update', kind);
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory helper: build an isolated environment for a Kiro ACP process.
// ---------------------------------------------------------------------------

/**
 * Build a fully isolated environment map so NO host personal Kiro/Builder-ID
 * state is inherited. Auth state lives under HOME/XDG (NOT just KIRO_HOME), so
 * all of HOME + the XDG dirs must be redirected (validated live — see
 * a4-kiro-acp-runtime-facts).
 */
export function buildAcpEnvironment(opts: {
  apiKey: string;
  home: string;
  kiroHome: string;
  pathPrefix?: string;
}): Record<string, string> {
  const path = opts.pathPrefix
    ? `${opts.pathPrefix}:/usr/local/bin:/usr/bin:/bin`
    : '/usr/local/bin:/usr/bin:/bin';

  return {
    HOME: opts.home,
    KIRO_HOME: opts.kiroHome,
    XDG_CONFIG_HOME: `${opts.home}/.config`,
    XDG_DATA_HOME: `${opts.home}/.local/share`,
    XDG_STATE_HOME: `${opts.home}/.local/state`,
    XDG_CACHE_HOME: `${opts.home}/.cache`,
    KIRO_API_KEY: opts.apiKey,
    KIRO_DISABLE_UPDATE: '1',
    KIRO_TELEMETRY: 'off',
    NO_COLOR: '1',
    PATH: path,
    GIT_TERMINAL_PROMPT: '0',
  };
}

// ---------------------------------------------------------------------------
// Tool + profile policy.
// ---------------------------------------------------------------------------

/** The ONLY tools the A4 read-only backend permits (available + trusted). */
export const ACP_READONLY_TOOLS = ['read', 'grep', 'glob'] as const;
export type AcpReadonlyTool = (typeof ACP_READONLY_TOOLS)[number];

/** The --trust-tools CLI flag value. */
export const ACP_TRUST_TOOLS_FLAG = ACP_READONLY_TOOLS.join(',');

export function isAllowedReadonlyTool(name: string): boolean {
  return (ACP_READONLY_TOOLS as readonly string[]).includes(name);
}

/**
 * Agent-name prefix for the bridge-owned read-only agent. The full name is
 * unguessable per job (see newBridgeAgentName) so a staged/tracked project
 * CANNOT ship a same-named `<cwd>/.kiro/agents/<name>.json` that would override
 * the bridge agent (Kiro resolves workspace agents ahead of global ones for the
 * same name — Critical Finding #1). This is the primary agent-override defense.
 */
export const ACP_AGENT_NAME_PREFIX = 'mcp_ro_';

/** Match a bridge-owned agent name (prefix + 32 lowercase hex chars). */
export const ACP_AGENT_NAME_PATTERN = /^mcp_ro_[0-9a-f]{32}$/;

/** Generate a fresh, unguessable bridge agent name for one job. */
export function newBridgeAgentName(randomHex: () => string): string {
  return `${ACP_AGENT_NAME_PREFIX}${randomHex()}`;
}

// ---------------------------------------------------------------------------
// Read-only profiles: only audit, plan, review may use the Kiro backend.
// ---------------------------------------------------------------------------

const READONLY_PROFILES = ['audit', 'plan', 'review'] as const;

export function isReadonlyProfile(profile: string): boolean {
  return (READONLY_PROFILES as readonly string[]).includes(profile);
}

/** Assert a profile is read-only. Throws FORBIDDEN_PROFILE for `implement`. */
export function assertReadonlyProfile(profile: string): void {
  if (!isReadonlyProfile(profile)) {
    throw new BridgeError('FORBIDDEN_PROFILE',
      `profile "${profile}" requires write capability (A5); denied in A4 read-only backend`, 403);
  }
}

// ---------------------------------------------------------------------------
// A5 — implement profile write capability policy.
//
// A5 grants a SINGLE additional profile (`implement`) the minimum capability to
// mutate files inside the disposable job workspace. The capability is TRUSTED
// CODE POLICY, keyed on the profile id only — never inferred from prompt text.
//
// Write-tool identity (official Kiro Built-in Tools documentation):
//   Tool name: `write`. Documented aliases: `fs_write`, `fsWrite`. The
//   canonical documented identifier `write` is used here (schema-validated with
//   `kiro-cli 2.5.0 agent validate`). Operations: create + modify + insert, NO
//   shell. Read stays `read`+`grep`+`glob` exactly as A4.
//
//   Kiro performs these writes IN-PROCESS against its own cwd (the writable
//   job /workspace volume). The client advertises NO fs capability
//   (clientCapabilities:{}) — no server->client fs/* delegation ever occurs.
//   The A4 fail-closed server-request backstop (PRIVILEGED_REQUEST_PREFIXES)
//   remains fully intact and unchanged.
//
// Permission model (documented, corrected in the A5 write-policy remediation):
//   - `tools` makes the write tool AVAILABLE/visible to the agent.
//   - `allowedTools` pre-approves a tool WITHOUT prompting AND, per the official
//     Agent Configuration Reference, OVERRIDES any allowable pattern configured
//     in `toolsSettings`. Therefore `write` MUST NOT appear in `allowedTools`:
//     doing so would nullify the path scoping. Only read/grep/glob are globally
//     pre-approved.
//   - `toolsSettings.write.allowedPaths` provides the path-scoped, non-
//     interactive write permission ("paths that can be written to without
//     prompting"); `deniedPaths` explicitly denies non-workspace locations.
//     This is the intended A5 write-permission primitive — no globally trusted
//     write is required (mirrors Kiro's own Development Workflow Agent example,
//     where `write` is in `tools` but NOT in `allowedTools`).
//   - `--trust-tools` (headless upfront permission) likewise carries ONLY
//     read/grep/glob — never write.
//
// Deliberately NOT granted: shell/terminal (executeCmd), web (web_search/
// web_fetch), MCP, AWS (use_aws), subagents/delegation (agent_crew/delegate),
// hooks, or any wildcard. No `-a`/`--trust-all-tools`/`--yolo`.
// ---------------------------------------------------------------------------

/** The canonical Kiro 2.5.0 file-mutation tool name (aliases: fs_write, fsWrite). */
export const ACP_WRITE_TOOL = 'write' as const;

/** implement: read/grep/glob (A4) PLUS the single canonical `write` mutation tool. */
export const ACP_IMPLEMENT_TOOLS = [...ACP_READONLY_TOOLS, ACP_WRITE_TOOL] as const;
export type AcpImplementTool = (typeof ACP_IMPLEMENT_TOOLS)[number];

/**
 * The --trust-tools value for implement. Documented policy: write is NEVER
 * globally trusted — it is path-scoped via toolsSettings.write.allowedPaths.
 * So implement's upfront trust set is EXACTLY the read-only set (read,grep,glob),
 * identical to {@link ACP_TRUST_TOOLS_FLAG}.
 */
export const ACP_IMPLEMENT_TRUST_TOOLS_FLAG = ACP_READONLY_TOOLS.join(',');

/**
 * Separate bridge-owned agent identity prefix for implement jobs. A distinct,
 * still-unguessable per-job name (mcp_impl_<random>) — never a fixed/predictable
 * name — so a staged/tracked project cannot ship a same-named agent to override
 * bridge policy (same defense as A4's mcp_ro_).
 */
export const ACP_IMPL_AGENT_NAME_PREFIX = 'mcp_impl_';
export const ACP_IMPL_AGENT_NAME_PATTERN = /^mcp_impl_[0-9a-f]{32}$/;

/** The four profiles the Kiro backend may serve (A4 read-only three + A5 implement). */
const KIRO_PROFILES = [...READONLY_PROFILES, 'implement'] as const;

/** Only `implement` receives A5 write capability. */
const WRITE_PROFILES = ['implement'] as const;

export function isWriteProfile(profile: string): boolean {
  return (WRITE_PROFILES as readonly string[]).includes(profile);
}

/**
 * Assert a profile is a Kiro-servable profile (audit/plan/review/implement).
 * Throws FORBIDDEN_PROFILE for anything else (fail closed). Unlike A4's
 * assertReadonlyProfile, `implement` is now accepted — but ONLY through the
 * write-capability lane resolved by {@link resolveProfileCapability}.
 */
export function assertKiroProfile(profile: string): void {
  if (!(KIRO_PROFILES as readonly string[]).includes(profile)) {
    throw new BridgeError('FORBIDDEN_PROFILE',
      `profile "${profile}" is not a Kiro-servable profile`, 403);
  }
}

/**
 * ACP tool_call `kind` categories permitted for a READ-ONLY profile. These are
 * the coarse ACP categories reported in session/update, NOT agent tool ids.
 * (A4 parity — audit/plan/review.)
 */
export const READONLY_TOOL_KINDS: ReadonlySet<string> = new Set([
  'read', 'grep', 'glob', 'search', 'fetch_read', 'list',
]);

/**
 * Additional ACP tool_call `kind` categories permitted for the IMPLEMENT
 * profile: the file-mutation categories only. Shell/execute, web/fetch(write),
 * mcp, aws and delegation kinds remain disallowed and fail validation.
 */
export const WRITE_TOOL_KINDS: ReadonlySet<string> = new Set([
  'edit', 'create', 'write', 'fsWrite', 'fs_write', 'delete', 'move',
]);

// ---------------------------------------------------------------------------
// A5 — tool OUTCOME semantics.
//
// A write/mutation tool being CALLED is NOT proof it SUCCEEDED. ACP reports a
// terminal `status` on each tool_call / tool_call_update (validated against
// Kiro 2.5.0: pending | in_progress | completed | failed). A mutation whose
// terminal status is a failure (failed/denied/refused/error/…) means the write
// did not land — even if the assistant turn still reaches `end_turn`. These
// helpers evaluate the bounded status EVIDENCE only; assistant prose is NEVER
// inspected for failure keywords.
// ---------------------------------------------------------------------------

/** ACP tool_call `status` values that mean the tool did NOT succeed. */
export const FAILED_TOOL_STATUSES: ReadonlySet<string> = new Set([
  'failed', 'error', 'errored', 'denied', 'refused', 'rejected',
  'cancelled', 'canceled', 'aborted', 'timeout', 'timed_out',
]);

/** True when a tool_call status denotes an unsuccessful terminal outcome. */
export function isFailedToolStatus(status: string | undefined | null): boolean {
  return typeof status === 'string' && FAILED_TOOL_STATUSES.has(status.toLowerCase());
}

/** Minimal tool-call outcome shape carried across the runner result boundary. */
export interface ToolCallOutcome {
  kind: string;
  status?: string;
}

/**
 * Return the file-mutation tool calls that ended in a FAILURE status. A
 * non-empty result is proof that at least one attempted write/edit did not
 * succeed and the implement job must fail (FAILED_AGENT), regardless of the
 * assistant stopReason. Pure + bounded — unit-testable without Docker or a
 * provider call.
 */
export function failedMutationToolCalls<T extends ToolCallOutcome>(toolCalls: readonly T[]): T[] {
  return toolCalls.filter((tc) => WRITE_TOOL_KINDS.has(tc.kind) && isFailedToolStatus(tc.status));
}

export interface ProfileCapability {
  /** true only for implement: the job workspace volume is mounted writable. */
  workspaceWritable: boolean;
  /** Agent-config `tools` array (available + trusted). */
  agentTools: readonly string[];
  /** --trust-tools flag value. */
  trustTools: string;
  /** Unguessable per-job agent-name prefix for this lane. */
  agentNamePrefix: string;
  /** Regex the generated agent name must match (evidence/tests). */
  agentNamePattern: RegExp;
  /** ACP tool_call kinds allowed during validation (superset for implement). */
  allowedToolKinds: ReadonlySet<string>;
}

/**
 * Resolve the trusted capability set for a Kiro profile. Read-only profiles get
 * the exact A4 capability; `implement` gets read + the single fsWrite tool, a
 * writable workspace, the mcp_impl_ identity, and the write tool-kind allowlist.
 * Throws for non-Kiro profiles (fail closed).
 */
export function resolveProfileCapability(profile: string): ProfileCapability {
  assertKiroProfile(profile);
  if (isWriteProfile(profile)) {
    return {
      workspaceWritable: true,
      agentTools: ACP_IMPLEMENT_TOOLS,
      trustTools: ACP_IMPLEMENT_TRUST_TOOLS_FLAG,
      agentNamePrefix: ACP_IMPL_AGENT_NAME_PREFIX,
      agentNamePattern: ACP_IMPL_AGENT_NAME_PATTERN,
      allowedToolKinds: new Set([...READONLY_TOOL_KINDS, ...WRITE_TOOL_KINDS]),
    };
  }
  return {
    workspaceWritable: false,
    agentTools: ACP_READONLY_TOOLS,
    trustTools: ACP_TRUST_TOOLS_FLAG,
    agentNamePrefix: ACP_AGENT_NAME_PREFIX,
    agentNamePattern: ACP_AGENT_NAME_PATTERN,
    allowedToolKinds: READONLY_TOOL_KINDS,
  };
}
