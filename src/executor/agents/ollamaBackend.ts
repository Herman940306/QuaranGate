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
import type { Ollama, Message } from 'ollama';
import { BridgeError } from '../../shared/errors.js';
import { isWriterProfile, type AgentProfileId, type AgentResourcePolicy } from '../../shared/agents.js';
import type { AgentBackendAdapter } from './jobEngine.js';
import type { ConfinedTarget } from '../execops.js';
import { WORKSPACE_PATH, toRunnerLimits, buildOllamaReadHelperCreateBody, ollamaReadHelperContainerName, workspaceVolumeName } from './sandboxSpec.js';
import {
  createContainer, startContainer, stopContainer, removeContainer,
} from '../docker.js';
import {
  ollamaReadFile,
  ollamaListFiles,
  ollamaLiteralSearch,
  OLLAMA_O1_LIMITS,
  type OllamaToolResult,
} from './ollamaTools.js';

// ---------------------------------------------------------------------------
// O1 Qualification Limits (§8) — frozen, model/caller cannot raise them
// ---------------------------------------------------------------------------

const MAX_TURNS = 10;
const MAX_TOOL_CALLS_TOTAL = 50;
const MAX_TOOL_CALLS_PER_TURN = 10;

// ---------------------------------------------------------------------------
// Ollama tool definitions for native tool-calling
// ---------------------------------------------------------------------------

const OLLAMA_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the contents of a single file from the workspace. Returns file content as text. Maximum 256 KiB per file.',
      parameters: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string' as const,
            description: 'Workspace-relative path to the file (e.g., "src/index.ts")',
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
            type: 'number' as const,
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
      description: 'Search for a literal string (fixed-string, not regex) across files in a directory. Skips sensitive files. Maximum 100 files searched, 200 results total.',
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

// ---------------------------------------------------------------------------
// Tool argument validation — strict schema (§4)
// ---------------------------------------------------------------------------

interface ReadFileArgs { path: string }
interface ListFilesArgs { path: string; maxDepth?: number }
interface LiteralSearchArgs { directory: string; query: string }

function validateReadFileArgs(args: unknown): ReadFileArgs {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new BridgeError('MALFORMED_REQUEST', 'read_file: arguments must be a plain object', 400);
  }
  const obj = args as Record<string, unknown>;
  if (typeof obj.path !== 'string' || obj.path.length === 0) {
    throw new BridgeError('MALFORMED_REQUEST', 'read_file: path must be a non-empty string', 400);
  }
  for (const key of Object.keys(obj)) {
    if (key !== 'path') throw new BridgeError('MALFORMED_REQUEST', `read_file: unexpected field "${key}"`, 400);
  }
  return { path: obj.path };
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
  /** Stager image for workspace staging (generic runner/helper image). */
  stagerImage: string;
  /** Injectable Ollama constructor for testing. */
  OllamaClass: typeof import('ollama').Ollama;
}

function log(msg: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', msg, ...fields }));
}

export class OllamaBackend implements AgentBackendAdapter {
  private readonly ollama: Ollama;
  private helperContainerId: string | null = null;
  private target: ConfinedTarget | null = null;
  private baseCommit: string | null = null;
  private turnCount = 0;
  private toolCallsTotal = 0;
  private readonly aggregateReadTracker = { bytesRead: 0 };

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

    // §9: one Ollama client per active job
    this.ollama = new opts.OllamaClass({ host: opts.ollamaHost });
  }

  async prepare(signal: AbortSignal): Promise<void> {
    log('ollama backend: staging workspace', { jobId: this.job.jobId });
    this.checkAbort(signal);

    // Stage committed-HEAD snapshot via the stager (same as Kiro backend)
    const volumeName = workspaceVolumeName(this.job.jobId);
    // Volume is created by the sandbox infrastructure before we get here;
    // we just need to set up the read-helper against it.
    // Note: in full integration, sandbox.stageWorkspace is called by the engine
    // or by a preceding stager step. For O1 we track the staged volume by name.

    // Create the read-helper container (long-lived, RO workspace mount)
    log('ollama backend: creating read-helper container', { jobId: this.job.jobId });
    this.checkAbort(signal);

    const limits = toRunnerLimits(this.job.policy);
    const helperName = ollamaReadHelperContainerName(this.job.jobId);
    const body = buildOllamaReadHelperCreateBody({
      image: this.opts.helperImage,
      jobId: this.job.jobId,
      workspaceVolumeName: volumeName,
      limits,
    });

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
      { role: 'user', content: this.job.prompt },
    ];

    // Bounded inference loop (§8)
    while (this.turnCount < MAX_TURNS) {
      this.checkAbort(signal);
      this.turnCount++;

      log('ollama backend: turn', { jobId: this.job.jobId, turn: this.turnCount });

      // §9: stream: true as required by O1 spec
      let fullContent = '';
      let toolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];

      const stream = await this.ollama.chat({
        model: this.opts.modelQualifier,
        messages,
        tools: OLLAMA_TOOL_DEFINITIONS as unknown as import('ollama').Tool[],
        stream: true,
      });

      // Consume the stream
      for await (const chunk of stream) {
        this.checkAbort(signal);
        if (chunk.message.content) fullContent += chunk.message.content;
        if (chunk.message.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            toolCalls.push(tc as { function: { name: string; arguments: Record<string, unknown> } });
          }
        }
        if (chunk.done) break;
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
        // No tool calls — conversation complete
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
      for (const toolCall of toolCalls) {
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

        const toolResultContent = await this.executeToolCall(toolCall);
        messages.push({
          role: 'tool',
          content: toolResultContent,
        });
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
    this.checkAbort(signal);
    // No artifact production (§21 — O1 is read-only, never produces B3 artifact)
    return {
      summary: `Ollama O1 read-only execution completed (${this.turnCount} turns, ${this.toolCallsTotal} tool calls, ${this.aggregateReadTracker.bytesRead} bytes read)`,
      exitCode: 0,
      baseCommit: this.baseCommit,
      // No changedFiles (read-only, no mutations)
      // No artifactResult (never produced by Ollama O1)
    };
  }

  isAgentFailure(e: unknown): boolean {
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
    // Always remove the read-helper container (§12)
    if (this.helperContainerId) {
      log('ollama backend: cleaning up read-helper', { jobId: this.job.jobId });
      try { await stopContainer(this.helperContainerId, 2); } catch { /* best-effort */ }
      try { await removeContainer(this.helperContainerId, true); } catch { /* best-effort */ }
      this.helperContainerId = null;
    }
    // Also attempt by name (defense in depth)
    const helperName = ollamaReadHelperContainerName(this.job.jobId);
    try { await removeContainer(helperName, true); } catch { /* best-effort */ }
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
