/**
 * Ollama O1 governed read-only backend adapter (Phase O1).
 *
 * Implements AgentBackendAdapter for Ollama with strict read-only capability:
 *
 *   - Refuses writer/implement profiles before inference (§21)
 *   - Stages committed-HEAD snapshot via sandbox stager (§10)
 *   - Long-lived read-helper container: workspace volume RO, NetworkMode none,
 *     ReadonlyRootfs, CapDrop ALL, no-new-privileges, non-root, no host binds
 *   - Native tool-call authority ONLY (message.tool_calls) (§4)
 *   - Bounded turns/tool-call limits (§8)
 *   - Job-specific AbortController for per-job cancellation (§9)
 *   - Canonical path + sensitive-file enforcement on every tool (§13/§14)
 *   - No artifact production (read-only, no B3 canonical artifact)
 */
import type { Ollama, Message, ChatResponse, AbortableAsyncIterator } from 'ollama';
import { BridgeError } from '../../shared/errors.js';
import { isWriterProfile, type AgentProfileId, type AgentResourcePolicy } from '../../shared/agents.js';
import type { AgentBackendAdapter } from './jobEngine.js';
import type { ConfinedTarget } from '../execops.js';
import { WORKSPACE_PATH, toRunnerLimits, buildOllamaReadHelperCreateBody, ollamaReadHelperContainerName } from './sandboxSpec.js';
import {
  createContainer, startContainer, stopContainer, removeContainer, removeVolume,
} from '../docker.js';
import {
  ollamaReadFile,
  ollamaListFiles,
  ollamaLiteralSearch,
  OLLAMA_O1_LIMITS,
  DEFAULT_READ_START_LINE,
  DEFAULT_READ_MAX_LINES,
  MAX_READ_LINES,
  type OllamaToolResult,
} from './ollamaTools.js';

// ---------------------------------------------------------------------------
// O1 Qualification Limits (§8) — frozen, model/caller cannot raise them
// ---------------------------------------------------------------------------

export const OLLAMA_O1_EXECUTION_LIMITS = Object.freeze({
  MAX_TURNS: 16,
  MAX_TOOL_CALLS_TOTAL: 64,
  MAX_TOOL_CALLS_PER_TURN: 10,
});

const { MAX_TURNS, MAX_TOOL_CALLS_TOTAL, MAX_TOOL_CALLS_PER_TURN } = OLLAMA_O1_EXECUTION_LIMITS;
export const MAX_OLLAMA_CHAT_ENVELOPE_BYTES = 48 * 1024;
const MAX_RESULT_SUMMARY_CHARS = 16_384;

export const OLLAMA_O1_SYSTEM_MESSAGE = [
  'You are QuaranGate O1, a read-only repository audit, plan, and review assistant.',
  'Use only the provided read tools.',
  'Claims about repository contents must be based on those tools; never claim repository inspection without using them.',
  'For repository questions, prefer the shortest evidence path: literal_search to locate a symbol or literal, then read_file for the smallest relevant window; use list_files only when the path is genuinely unknown.',
  'Do not repeat the same search or read after it has already produced sufficient evidence. Once the requested fact is proven, stop calling tools and answer.',
  'Source constants may be written as simple deterministic expressions such as 48 * 1024; evaluate such arithmetic from the inspected source instead of searching only for the decimal result.',
  'For review tasks, direct defining-source evidence is sufficient to decide a claim unless the user explicitly requires test corroboration; once that source proves or refutes the claim, return the verdict instead of continuing to search.',
  'Never treat SEARCH_INCOMPLETE or searchComplete=false as proof that a symbol or literal is absent. Narrow the search directory and try a different bounded search; for implementation/code-symbol claims, search src before making an absence claim.',
  'A task that requires no repository inspection may be answered without a tool call.',
  'Return a concise final answer only.',
  'Do not include raw prompts, raw tool-result JSON, secrets, credentials, host paths, or hidden runtime state.',
  'You have no write, shell, web, apply, artifact, or fallback authority.',
].join(' ');

// ---------------------------------------------------------------------------
// Ollama tool definitions for native tool-calling
// ---------------------------------------------------------------------------

export const OLLAMA_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a bounded complete-line window from one workspace file. For large files, use literal_search to locate relevant code, then use startLine/maxLines; continue sequential reads with nextStartLine. Path-only calls default to startLine 1 and maxLines 200. Each response exposes at most 8 KiB of file content; 256 KiB is only the maximum eligible total file size.',
      parameters: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string' as const,
            description: 'Workspace-relative path to the file (e.g., "src/index.ts")',
          },
          startLine: {
            type: 'integer' as const,
            minimum: 1,
            description: 'First 1-based line to return (default 1)',
          },
          maxLines: {
            type: 'integer' as const,
            minimum: 1,
            maximum: 400,
            description: 'Maximum complete lines to return (default 200, maximum 400)',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List files and directories at a given path. Returns metadata only (no file contents). Maximum depth 3.',
      parameters: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string' as const,
            description: 'Workspace-relative directory path (e.g., "src" or ".")',
          },
          maxDepth: {
            type: 'integer' as const,
            minimum: 1,
            maximum: 3,
            description: 'Maximum directory depth to traverse (1-3, default 1)',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'literal_search',
      description: 'Recursively search for a literal string (fixed-string, not regex) across eligible regular files in a directory. Skips sensitive files. Maximum 100 eligible files searched and 200 results total. The result includes searchComplete; when false, absence is NOT proven and you must narrow the directory and search again before concluding the identifier is missing.',
      parameters: {
        type: 'object' as const,
        properties: {
          directory: {
            type: 'string' as const,
            description: 'Workspace-relative directory to search in',
          },
          query: {
            type: 'string' as const,
            description: 'Literal string to search for (1-1024 characters)',
          },
        },
        required: ['directory', 'query'],
        additionalProperties: false,
      },
    },
  },
] as const;

function buildOllamaChatRequest(modelQualifier: string, messages: Message[]) {
  return {
    model: modelQualifier,
    messages,
    tools: OLLAMA_TOOL_DEFINITIONS as unknown as import('ollama').Tool[],
    stream: true as const,
    think: false as const,
  };
}

/** UTF-8 size of exact JSON/request structure sent to Ollama. */
export function measureOllamaChatEnvelopeBytes(
  modelQualifier: string,
  messages: Message[],
): number {
  return Buffer.byteLength(
    JSON.stringify(buildOllamaChatRequest(modelQualifier, messages)),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Tool argument validation — strict schema (§4)
// ---------------------------------------------------------------------------

interface ReadFileArgs { path: string; startLine: number; maxLines: number }
interface ListFilesArgs { path: string; maxDepth?: number }
interface LiteralSearchArgs { directory: string; query: string }

export function validateReadFileArgs(args: unknown): ReadFileArgs {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new BridgeError('MALFORMED_REQUEST', 'read_file: arguments must be a plain object', 400);
  }
  const obj = args as Record<string, unknown>;
  if (typeof obj.path !== 'string' || obj.path.length === 0) {
    throw new BridgeError('MALFORMED_REQUEST', 'read_file: path must be a non-empty string', 400);
  }
  for (const key of Object.keys(obj)) {
    if (key !== 'path' && key !== 'startLine' && key !== 'maxLines') {
      throw new BridgeError('MALFORMED_REQUEST', `read_file: unexpected field "${key}"`, 400);
    }
  }
  const startLine = obj.startLine ?? DEFAULT_READ_START_LINE;
  if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
    throw new BridgeError('MALFORMED_REQUEST', 'read_file: startLine must be a positive integer', 400);
  }
  const maxLines = obj.maxLines ?? DEFAULT_READ_MAX_LINES;
  if (typeof maxLines !== 'number' || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > MAX_READ_LINES) {
    throw new BridgeError('MALFORMED_REQUEST', `read_file: maxLines must be an integer 1-${MAX_READ_LINES}`, 400);
  }
  return { path: obj.path, startLine, maxLines };
}

function validateListFilesArgs(args: unknown): ListFilesArgs {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new BridgeError('MALFORMED_REQUEST', 'list_files: arguments must be a plain object', 400);
  }
  const obj = args as Record<string, unknown>;
  if (typeof obj.path !== 'string' || obj.path.length === 0) {
    throw new BridgeError('MALFORMED_REQUEST', 'list_files: path must be a non-empty string', 400);
  }
  for (const key of Object.keys(obj)) {
    if (key !== 'path' && key !== 'maxDepth') throw new BridgeError('MALFORMED_REQUEST', `list_files: unexpected field "${key}"`, 400);
  }
  let maxDepth = 1;
  if (obj.maxDepth !== undefined) {
    if (typeof obj.maxDepth !== 'number' || !Number.isInteger(obj.maxDepth) || obj.maxDepth < 1 || obj.maxDepth > 3) {
      throw new BridgeError('MALFORMED_REQUEST', 'list_files: maxDepth must be an integer 1-3', 400);
    }
    maxDepth = obj.maxDepth;
  }
  return { path: obj.path, maxDepth };
}

function validateLiteralSearchArgs(args: unknown): LiteralSearchArgs {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new BridgeError('MALFORMED_REQUEST', 'literal_search: arguments must be a plain object', 400);
  }
  const obj = args as Record<string, unknown>;
  if (typeof obj.directory !== 'string' || obj.directory.length === 0) {
    throw new BridgeError('MALFORMED_REQUEST', 'literal_search: directory must be a non-empty string', 400);
  }
  if (typeof obj.query !== 'string' || obj.query.length === 0 || obj.query.length > 1024) {
    throw new BridgeError('MALFORMED_REQUEST', 'literal_search: query must be 1-1024 characters', 400);
  }
  for (const key of Object.keys(obj)) {
    if (key !== 'directory' && key !== 'query') throw new BridgeError('MALFORMED_REQUEST', `literal_search: unexpected field "${key}"`, 400);
  }
  return { directory: obj.directory, query: obj.query };
}

// ---------------------------------------------------------------------------
// OllamaBackend
// ---------------------------------------------------------------------------

export interface OllamaJob {
  jobId: string;
  principalId: string;
  backend: 'ollama';
  project: string;
  profile: AgentProfileId;
  prompt: string;
  hostPath: string;    // trusted project host path from config
  policy: AgentResourcePolicy;
}

export interface OllamaBackendOptions {
  ollamaHost: string;
  modelQualifier: string;
  helperImage: string;
  sensitiveReadGlobs: readonly string[];
  /** RunnerSandbox dependency for workspace staging. */
  sandbox: import('./sandboxRunner.js').RunnerSandbox;
  /** Injectable Ollama constructor for testing. */
  OllamaClass: typeof import('ollama').Ollama;
  /** Injectable base transport; production defaults to global fetch. */
  fetch?: typeof fetch;
}

function log(msg: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', msg, ...fields }));
}

class OllamaAgentOutputError extends Error {
  constructor(message = 'ollama backend returned no final answer') {
    super(message);
    this.name = 'OllamaAgentOutputError';
  }
}

/** Model-originated native-tool contract violation; never infrastructure. */
class OllamaModelToolCallError extends Error {
  constructor(toolName: string) {
    super(`ollama backend model emitted malformed ${toolName} tool call`);
    this.name = 'OllamaModelToolCallError';
  }
}

function safeOllamaToolName(value: unknown): string {
  return value === 'read_file' || value === 'list_files' || value === 'literal_search'
    ? value
    : 'unknown';
}

function boundedToolErrorCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'other';
}

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Build content-free, bounded tool telemetry. Never include arguments, paths,
 * queries, filenames, matches, file content, or raw tool-result JSON.
 */
function toolResultLogFields(toolName: unknown, rawResult: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    toolName: safeOllamaToolName(toolName),
    resultBytes: Buffer.byteLength(rawResult, 'utf8'),
  };

  try {
    const parsed = JSON.parse(rawResult) as { success?: unknown; error?: unknown; data?: unknown };
    if (typeof parsed.success === 'boolean') fields.success = parsed.success;
    const errorCode = boundedToolErrorCode(parsed.error);
    if (errorCode !== null) fields.errorCode = errorCode;

    if (parsed.success === true && typeof parsed.data === 'object' && parsed.data !== null && !Array.isArray(parsed.data)) {
      const data = parsed.data as Record<string, unknown>;
      if (safeOllamaToolName(toolName) === 'list_files') {
        const itemCount = safeNonNegativeInteger(data.count);
        if (itemCount !== null) fields.itemCount = itemCount;
        if (typeof data.truncated === 'boolean') fields.truncated = data.truncated;
      } else if (safeOllamaToolName(toolName) === 'read_file') {
        const contentBytes = safeNonNegativeInteger(data.contentBytes);
        if (contentBytes !== null) fields.contentBytes = contentBytes;
        if (typeof data.eof === 'boolean') fields.eof = data.eof;
      } else if (safeOllamaToolName(toolName) === 'literal_search') {
        const filesSearched = safeNonNegativeInteger(data.filesSearched);
        const totalMatches = safeNonNegativeInteger(data.totalMatches);
        if (filesSearched !== null) fields.filesSearched = filesSearched;
        if (totalMatches !== null) fields.totalMatches = totalMatches;
        if (typeof data.searchComplete === 'boolean') fields.searchComplete = data.searchComplete;
        if (typeof data.truncated === 'boolean') fields.truncated = data.truncated;
      }
    }
  } catch {
    fields.success = null;
    fields.errorCode = 'UNPARSEABLE_TOOL_RESULT';
  }

  return fields;
}

function boundedDoneReason(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'other';
}

/** Stable in-memory signature only; never logged or persisted. */
function canonicalToolCallValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalToolCallValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalToolCallValue(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function toolCallSignature(toolCall: { function?: { name?: unknown; arguments?: unknown } }): string {
  return `${String(toolCall.function?.name ?? '')}:${canonicalToolCallValue(toolCall.function?.arguments)}`;
}

export class OllamaBackend implements AgentBackendAdapter {
  private readonly ollama: Ollama;
  private activeJobSignal: AbortSignal | null = null;
  private helperContainerId: string | null = null;
  /** True once helper creation may have allocated a name-addressable resource. */
  private helperCleanupRequired = false;
  private workspaceVolumeName: string | null = null;
  private target: ConfinedTarget | null = null;
  private baseCommit: string | null = null;
  private turnCount = 0;
  private toolCallsTotal = 0;
  private readonly seenToolCallSignatures = new Set<string>();
  private readonly aggregateReadTracker = { bytesRead: 0 };
  private finalAnswer = '';

  constructor(
    private readonly job: OllamaJob,
    private readonly opts: OllamaBackendOptions,
  ) {
    // §21: Refuse writer/implement profiles BEFORE inference, BEFORE any Docker work
    if (isWriterProfile(job.profile)) {
      throw new BridgeError(
        'FORBIDDEN_PROFILE',
        `Ollama O1 backend does not support writer profile "${job.profile}" — O1 is read-only`,
        403,
      );
    }

    // §9: one Ollama client and transport wrapper per active job. The wrapper
    // keeps the SDK's request signal while adding QuaranGate job cancellation.
    const transportFetch = opts.fetch ?? globalThis.fetch;
    this.ollama = new opts.OllamaClass({
      host: opts.ollamaHost,
      fetch: (input, init) => {
        const jobSignal = this.activeJobSignal;
        if (!jobSignal) return transportFetch(input, init);
        const sdkSignal = init?.signal;
        const signal = sdkSignal && sdkSignal !== jobSignal
          ? AbortSignal.any([sdkSignal, jobSignal])
          : jobSignal;
        return transportFetch(input, { ...(init ?? {}), signal });
      },
    });
  }

  async prepare(signal: AbortSignal): Promise<void> {
    try {
      log('ollama backend: staging workspace', { jobId: this.job.jobId });
      this.checkAbort(signal);

      // R2: Stage committed-HEAD snapshot via RunnerSandbox (trusted, proven).
      // O1 read-only jobs explicitly opt out of clean-worktree requirement —
      // staging archives ONLY committed HEAD bytes via `git archive HEAD`,
      // never untracked/ignored/modified working-tree content.
      const staged = await this.opts.sandbox.stageWorkspace({
        jobId: this.job.jobId,
        hostPath: this.job.hostPath,
        gitRequired: true,
        rejectTrackedSymlinks: false, // O1 is read-only, no A5 write restrictions
        requireCleanWorktree: false,  // R2: allow staging from dirty host for O1
      });
      this.workspaceVolumeName = staged.volumeName;
      this.baseCommit = staged.baseCommit;

      log('ollama backend: workspace staged', {
        jobId: this.job.jobId,
        volumeName: this.workspaceVolumeName,
        baseCommit: this.baseCommit,
      });

      // Create the read-helper container (long-lived, RO workspace mount)
      log('ollama backend: creating read-helper container', { jobId: this.job.jobId });
      this.checkAbort(signal);

      const limits = toRunnerLimits(this.job.policy);
      const helperName = ollamaReadHelperContainerName(this.job.jobId);
      const body = buildOllamaReadHelperCreateBody({
        image: this.opts.helperImage,
        jobId: this.job.jobId,
        workspaceVolumeName: this.workspaceVolumeName,
        limits,
      });

      // Set before the Docker call: creation can fail after Docker has reserved
      // the name but before it returns an id, so cleanup must cover that case.
      this.helperCleanupRequired = true;
      this.helperContainerId = await createContainer(helperName, body as unknown as Record<string, unknown>);
      await startContainer(this.helperContainerId);
      this.checkAbort(signal);

      // Construct ConfinedTarget from the helper container + WORKSPACE_PATH
      this.target = {
        containerId: this.helperContainerId,
        workspace: WORKSPACE_PATH,
      };

      log('ollama backend: read-helper ready', {
        jobId: this.job.jobId,
        helperContainerId: this.helperContainerId,
      });
    } catch (e) {
      // R2: Fail-closed cleanup — if staging succeeded but helper creation/start
      // fails, dispose the staged volume. If helper was created but start failed,
      // remove both helper and staged volume. Idempotent cleanup handles all cases.
      await this.cleanup();
      throw e;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.target) {
      throw new BridgeError('PRECONDITION_FAILED', 'ollama backend: target not prepared', 500);
    }

    log('ollama backend: starting inference', {
      jobId: this.job.jobId,
      model: this.opts.modelQualifier,
      profile: this.job.profile,
    });

    const messages: Message[] = [
      { role: 'system', content: OLLAMA_O1_SYSTEM_MESSAGE },
      { role: 'user', content: this.job.prompt },
    ];

    // Bounded inference loop (§8)
    while (this.turnCount < MAX_TURNS) {
      this.checkAbort(signal);
      this.turnCount++;

      log('ollama backend: turn', { jobId: this.job.jobId, turn: this.turnCount });

      // §9: stream: true as required by O1 spec
      let fullContent = '';
      let contentBytes = 0;
      let thinkingBytes = 0;
      let done = false;
      let doneReason: string | null = null;
      let toolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];

      const request = buildOllamaChatRequest(this.opts.modelQualifier, messages);
      this.requireEnvelopeWithinBudget(messages);

      // The Ollama 0.6.x client exposes abort() on streamed requests and on the
      // per-client instance. Couple QuaranGate's per-job AbortSignal to that
      // transport so timeout/cancel cannot leave a stalled provider request
      // running after the job has failed closed. The client is job-scoped, so
      // aborting here cannot affect another job.
      const abortReason = (): Error => signal.reason instanceof Error
        ? signal.reason
        : new Error('Ollama job cancelled');
      let removeAbortListener = () => {};
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          try { this.ollama.abort(); } catch { /* transport abort is best-effort */ }
          reject(abortReason());
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      });
      let stream: AbortableAsyncIterator<ChatResponse>;
      try {
        this.activeJobSignal = signal;
        const chatPromise = Promise.resolve(this.ollama.chat(request));
        // If cancellation wins before response headers arrive, abort the
        // eventual iterator as soon as the client creates it.
        void chatPromise.then((lateStream) => {
          if (signal.aborted) {
            try { lateStream.abort(); } catch { /* already closed */ }
          }
        }).catch(() => {});
        stream = await Promise.race([chatPromise, abortPromise]);

        // Consume the stream
        for await (const chunk of stream) {
          this.checkAbort(signal);
          if (chunk.message.content) {
            fullContent += chunk.message.content;
            contentBytes += Buffer.byteLength(chunk.message.content, 'utf8');
          }
          if (chunk.message.thinking) {
            thinkingBytes += Buffer.byteLength(chunk.message.thinking, 'utf8');
          }
          if (chunk.message.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              toolCalls.push(tc as { function: { name: string; arguments: Record<string, unknown> } });
            }
          }
          if (chunk.done) {
            done = true;
            doneReason = boundedDoneReason(chunk.done_reason);
            break;
          }
        }
      } finally {
        this.activeJobSignal = null;
        removeAbortListener();
      }
      // An abort can cause the transport iterator to end cleanly rather than
      // throw. Preserve the QuaranGate cancellation/timeout cause instead of
      // misclassifying that end as malformed provider output.
      this.checkAbort(signal);

      log('ollama backend: turn metadata', {
        jobId: this.job.jobId,
        turn: this.turnCount,
        contentBytes,
        thinkingBytes,
        toolCallCount: toolCalls.length,
        done,
        doneReason,
      });

      if (!done) {
        throw new OllamaAgentOutputError('ollama backend stream ended without terminal done signal');
      }

      // Add assistant response to conversation
      messages.push({
        role: 'assistant',
        content: fullContent,
        tool_calls: toolCalls.length > 0
          ? toolCalls as unknown as import('ollama').ToolCall[]
          : undefined,
      });

      // §4: ONLY native message.tool_calls are authoritative
      if (toolCalls.length === 0) {
        // No tool calls terminate successfully only with a useful public answer.
        // Hidden thinking is counted above but is never retained or promoted.
        if (fullContent.trim().length === 0) throw new OllamaAgentOutputError();
        this.finalAnswer = fullContent;
        log('ollama backend: inference complete (no tool calls)', {
          jobId: this.job.jobId, turns: this.turnCount,
        });
        break;
      }

      // Enforce per-turn tool-call limit (§8)
      if (toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
        throw new BridgeError(
          'FORBIDDEN_POLICY',
          `turn ${this.turnCount}: model requested ${toolCalls.length} tool calls, exceeds max ${MAX_TOOL_CALLS_PER_TURN} per turn`,
          403,
        );
      }

      // Execute each tool call
      for (const [turnToolCallIndex, toolCall] of toolCalls.entries()) {
        this.toolCallsTotal++;

        // Enforce total tool-call limit (§8)
        if (this.toolCallsTotal > MAX_TOOL_CALLS_TOTAL) {
          throw new BridgeError(
            'FORBIDDEN_POLICY',
            `total tool calls ${this.toolCallsTotal} exceeds max ${MAX_TOOL_CALLS_TOTAL}`,
            403,
          );
        }

        this.checkAbort(signal);

        const aggregateBytesBeforeCall = this.aggregateReadTracker.bytesRead;
        const signature = toolCallSignature(toolCall);
        const repeatedToolCall = this.seenToolCallSignatures.has(signature);
        let rawToolResultContent: string;
        if (repeatedToolCall) {
          // The staged workspace is immutable for the lifetime of this job, so
          // the exact same tool + arguments cannot produce new evidence. Do not
          // waste I/O or aggregate-read budget; give the model a bounded signal
          // to use the evidence it already has or change the query/window.
          rawToolResultContent = JSON.stringify({
            success: false,
            error: 'REPEATED_TOOL_CALL',
            details: {
              message: 'Exact tool call already executed against this immutable snapshot. Use existing evidence or change arguments; if the task is answered, return the final answer now.',
            },
          });
        } else {
          this.seenToolCallSignatures.add(signature);
          try {
            rawToolResultContent = await this.executeToolCall(toolCall);
          } catch (e) {
            const errorCode = e instanceof BridgeError ? boundedToolErrorCode(e.code) : null;
            log('ollama backend: tool metadata', {
              jobId: this.job.jobId,
              turn: this.turnCount,
              turnToolCall: turnToolCallIndex + 1,
              toolCallTotal: this.toolCallsTotal,
              toolName: safeOllamaToolName(toolCall.function?.name),
              success: false,
              resultBytes: 0,
              errorCode: errorCode ?? 'INTERNAL',
            });
            if (e instanceof BridgeError && e.code === 'MALFORMED_REQUEST') {
              throw new OllamaModelToolCallError(safeOllamaToolName(toolCall.function?.name));
            }
            throw e;
          }
        }

        const toolLogFields = toolResultLogFields(toolCall.function?.name, rawToolResultContent);
        let envelopeWithheld = false;
        let toolResultMessage: Message = {
          role: 'tool',
          content: rawToolResultContent,
        };

        if (this.measureProjectedEnvelope(messages, toolResultMessage) > MAX_OLLAMA_CHAT_ENVELOPE_BYTES) {
          envelopeWithheld = true;
          // The raw window is not exposed to the model, so its provisional
          // content-byte charge must not consume the aggregate exposure budget.
          this.aggregateReadTracker.bytesRead = aggregateBytesBeforeCall;
          toolResultMessage = {
            role: 'tool',
            content: JSON.stringify({
              success: false,
              error: 'CONTEXT_BUDGET_EXCEEDED',
              details: {
                contentWithheld: true,
                resultBytes: Buffer.byteLength(rawToolResultContent, 'utf8'),
                envelopeLimitBytes: MAX_OLLAMA_CHAT_ENVELOPE_BYTES,
              },
            }),
          };
        }

        log('ollama backend: tool metadata', {
          jobId: this.job.jobId,
          turn: this.turnCount,
          turnToolCall: turnToolCallIndex + 1,
          toolCallTotal: this.toolCallsTotal,
          ...toolLogFields,
          envelopeWithheld,
        });

        this.requireEnvelopeWithinBudget([...messages, toolResultMessage]);
        messages.push(toolResultMessage);
      }
    }

    if (this.turnCount >= MAX_TURNS && messages[messages.length - 1]?.role !== 'assistant') {
      throw new BridgeError(
        'FORBIDDEN_POLICY',
        `reached maximum turn limit ${MAX_TURNS} without completion`,
        403,
      );
    }
  }

  async validate(signal: AbortSignal): Promise<{
    summary: string;
    exitCode: number;
    baseCommit?: string | null;
    changedFiles?: string[];
  }> {
    try {
      this.checkAbort(signal);
      if (this.finalAnswer.trim().length === 0) throw new OllamaAgentOutputError();
      // No artifact production (§21 — O1 is read-only, never produces B3 artifact)
      return {
        // Keep the provider response inside the existing public agent_result
        // summary contract. Tool transcripts and execution telemetry stay local.
        summary: this.finalAnswer.slice(0, MAX_RESULT_SUMMARY_CHARS),
        exitCode: 0,
        baseCommit: this.baseCommit,
        // No changedFiles (read-only, no mutations)
        // No artifactResult (never produced by Ollama O1)
      };
    } finally {
      // R2: Mirror the proven Kiro pattern — cleanup in finally block to ensure
      // helper container and staged workspace volume are always disposed, even if
      // validation or result construction throws.
      await this.cleanup();
    }
  }

  isAgentFailure(e: unknown): boolean {
    if (e instanceof OllamaAgentOutputError || e instanceof OllamaModelToolCallError) return true;
    if (!(e instanceof Error)) return false;
    const msg = e.message.toLowerCase();
    // Classify Ollama inference / network errors as agent failures
    return (
      msg.includes('fetch failed') ||
      msg.includes('connect econnrefused') ||
      msg.includes('model not found') ||
      msg.includes('ollama') ||
      (msg.includes('500') && msg.includes('http'))
    );
  }

  isDryRun(): boolean {
    // Ollama O1 is never a dry-run — it is always read-only by design
    return false;
  }

  async cleanup(): Promise<void> {
    // Successful O1 completion is permitted only after BOTH disposable
    // resources are proven removed by Docker's idempotent DELETE primitives.
    // Keep failed handles so a subsequent engine cleanup/restart can retry.
    // target is cleared immediately so no later operation can use resources
    // while cleanup is in progress.
    const helperContainerId = this.helperContainerId;
    const helperCleanupRequired = this.helperCleanupRequired;
    const workspaceVolumeName = this.workspaceVolumeName;
    this.target = null;

    const failures: string[] = [];

    if (helperContainerId || helperCleanupRequired) {
      const helperRef = helperContainerId ?? ollamaReadHelperContainerName(this.job.jobId);
      log('ollama backend: cleaning up read-helper', { jobId: this.job.jobId });
      if (helperContainerId) {
        // Stop is advisory before forced removal; removeContainer is the
        // authoritative cleanup operation and treats 404 as already clean.
        try { await stopContainer(helperContainerId, 2); } catch { /* force-remove still attempted */ }
      }
      try {
        await removeContainer(helperRef, true);
        this.helperContainerId = null;
        this.helperCleanupRequired = false;
      } catch {
        failures.push('read-helper');
      }
    }

    if (workspaceVolumeName) {
      log('ollama backend: cleaning up staged workspace', {
        jobId: this.job.jobId,
        volumeName: workspaceVolumeName,
      });
      try {
        // O1 uses the same trusted Docker primitive as RunnerSandbox, but does
        // not use disposeWorkspace() here because that generic helper is
        // intentionally best-effort. Production closeout requires strict proof
        // that an O1 successful job cannot hide a failed volume removal.
        await removeVolume(workspaceVolumeName, true);
        this.workspaceVolumeName = null;
      } catch {
        failures.push('workspace-volume');
      }
    }

    if (failures.length > 0) {
      throw new BridgeError(
        'DOCKER_UNAVAILABLE',
        `Ollama O1 resource cleanup failed for: ${failures.join(', ')}`,
        502,
      );
    }
  }

  private checkAbort(signal: AbortSignal): void {
    // §9: per-job cancellation check
    if (signal.aborted) {
      const reason = signal.reason instanceof Error
        ? signal.reason
        : new Error('Ollama job cancelled');
      throw reason;
    }
  }

  private measureProjectedEnvelope(messages: Message[], nextMessage: Message): number {
    return measureOllamaChatEnvelopeBytes(this.opts.modelQualifier, [...messages, nextMessage]);
  }

  private requireEnvelopeWithinBudget(messages: Message[]): void {
    const envelopeBytes = measureOllamaChatEnvelopeBytes(this.opts.modelQualifier, messages);
    if (envelopeBytes > MAX_OLLAMA_CHAT_ENVELOPE_BYTES) {
      throw new BridgeError(
        'FORBIDDEN_POLICY',
        `Ollama O1 request envelope ${envelopeBytes} bytes exceeds fixed limit ${MAX_OLLAMA_CHAT_ENVELOPE_BYTES}`,
        403,
      );
    }
  }

  private async executeToolCall(
    toolCall: { function: { name: string; arguments: Record<string, unknown> } },
  ): Promise<string> {
    const fn = toolCall.function;

    if (!fn || typeof fn.name !== 'string') {
      throw new BridgeError('MALFORMED_REQUEST', 'tool call missing function name', 400);
    }

    const toolName = fn.name;
    // §4: function.arguments is materialized object data from ollama-js — NO JSON.parse
    const args = fn.arguments;

    let result: OllamaToolResult;

    switch (toolName) {
      case 'read_file': {
        const validated = validateReadFileArgs(args);
        result = await ollamaReadFile(
          this.target!,
          validated.path,
          this.opts.sensitiveReadGlobs,
          this.aggregateReadTracker,
          validated.startLine,
          validated.maxLines,
        );
        break;
      }

      case 'list_files': {
        const validated = validateListFilesArgs(args);
        result = await ollamaListFiles(this.target!, validated.path, validated.maxDepth);
        break;
      }

      case 'literal_search': {
        const validated = validateLiteralSearchArgs(args);
        result = await ollamaLiteralSearch(
          this.target!,
          validated.directory,
          validated.query,
          this.opts.sensitiveReadGlobs,
        );
        break;
      }

      default:
        // §4: Unknown tool → hard policy failure (job becomes FAILED_POLICY)
        throw new BridgeError(
          'FORBIDDEN_POLICY',
          `unknown tool requested: "${toolName}"`,
          403,
        );
    }

    // Bound tool result bytes (§8) — enforce BYTE limit, not character length
    const resultJson = JSON.stringify(result);
    const resultBytes = Buffer.byteLength(resultJson, 'utf8');
    if (resultBytes > OLLAMA_O1_LIMITS.MAX_TOOL_RESULT_BYTES) {
      return JSON.stringify({
        success: false,
        error: 'TOOL_RESULT_TOO_LARGE',
        details: { bytes: resultBytes, limit: OLLAMA_O1_LIMITS.MAX_TOOL_RESULT_BYTES },
      });
    }

    return resultJson;
  }
}
