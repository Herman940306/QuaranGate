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
      // Server -> client REQUEST. Fail closed.
      this.handleServerRequest(msg.method as string, msg.id as number | string);
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

  /** A server-initiated request. We NEVER grant privileged capability. */
  private handleServerRequest(method: string, id: number | string): void {
    this.refusedRequestCount++;
    this.emit('request_refused', method);
    // Respond with a JSON-RPC error so the agent turn does not hang, but grant
    // nothing. This is the backstop that keeps write/shell/mcp/web unreachable
    // even if the available tool set were somehow widened.
    this.sendResponse(id, {
      error: { code: -32601, message: `method not permitted in read-only bridge session: ${method}` },
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
