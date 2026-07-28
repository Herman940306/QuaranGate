/**
 * MCP tool surface. Each tool: authenticate (already done at transport),
 * check scope, check target authorization, then delegate to the executor.
 * The `principal` is bound per-connection via AsyncLocalStorage set in index.ts.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BridgeError, asBridgeError } from '../shared/errors.js';
import { executor } from './executorClient.js';
import { audit, newReqId } from './audit.js';
import {
  type Principal,
  type Scope,
  principalCanTarget,
  principalHasScope,
} from './config.js';
import { currentPrincipal } from './context.js';
import { registerAgentTools } from './agentTools.js';

function require2(scope: Scope, targetId: string): Principal {
  const p = currentPrincipal();
  if (!p) throw new BridgeError('UNAUTHENTICATED', 'no principal in context', 401);
  if (!principalHasScope(p, scope)) throw new BridgeError('FORBIDDEN_SCOPE', `missing scope ${scope}`, 403);
  if (!principalCanTarget(p, targetId)) throw new BridgeError('FORBIDDEN_TARGET', `target ${targetId} not permitted for client ${p.id}`, 403);
  return p;
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: object): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: { ...data },
  };
}

/** Wrap a tool body with audit + uniform error mapping. */
function guarded(tool: string, fn: (args: any) => Promise<{ target?: string; result: object }>) {
  return async (args: any): Promise<ToolResult> => {
    const reqId = newReqId();
    const started = Date.now();
    const p = currentPrincipal();
    try {
      const { target, result } = await fn(args);
      audit({ reqId, principal: p?.id ?? null, tool, target: target ?? null, decision: 'allow', durationMs: Date.now() - started });
      return ok(result);
    } catch (e) {
      const be = asBridgeError(e);
      audit({ reqId, principal: p?.id ?? null, tool, target: args?.target ?? null, decision: 'deny', code: be.code, durationMs: Date.now() - started, detail: be.message });
      return { content: [{ type: 'text', text: JSON.stringify({ error: be.code, message: be.message }) }], isError: true };
    }
  };
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;


const TARGET_SUMMARY_SCHEMA = {
  id: z.string(),
  name: z.string(),
  source: z.enum(['manual', 'discovered']),
  running: z.boolean(),
  workspace: z.string(),
  composeProject: z.string().nullable(),
  composeService: z.string().nullable(),
} as const;

const TARGET_INSPECT_SCHEMA = {
  id: z.string(),
  running: z.boolean(),
  workspace: z.string(),
  image: z.string().optional(),
  status: z.string().optional(),
  source: z.enum(['manual', 'discovered']),
} as const;

const FILE_STAT_SCHEMA = {
  path: z.string(),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  size: z.number().int().nonnegative(),
  mode: z.string(),
  mtime: z.string(),
  linkTarget: z.string().optional(),
} as const;

const OK_PATH_SCHEMA = {
  ok: z.literal(true),
  path: z.string(),
} as const;

const EXEC_RESULT_SCHEMA = {
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
} as const;

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'mcp-ide-bridge', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: 'IDE automation confined to explicitly authorized Docker target containers. Every tool requires a `target` id from targets_list.' },
  );

  server.registerTool('targets_list', {
    title: 'List authorized targets',
    description: 'List Docker target containers this client is authorized to use.',
    inputSchema: {},
    outputSchema: { targets: z.array(z.object(TARGET_SUMMARY_SCHEMA)) },
    annotations: READ,
  }, guarded('targets_list', async () => {
    const p = currentPrincipal()!;
    if (!principalHasScope(p, 'targets:read')) throw new BridgeError('FORBIDDEN_SCOPE', 'missing scope targets:read', 403);
    const all = await executor.listTargets();
    const visible = all.filter((t) => principalCanTarget(p, t.id)).map((t) => ({
      id: t.id, name: t.name, source: t.source, running: t.running, workspace: t.workspace,
      composeProject: t.composeProject, composeService: t.composeService,
    }));
    return { result: { targets: visible } };
  }));

  server.registerTool('target_inspect', {
    title: 'Inspect a target',
    description: 'Show status, workspace and image for one authorized target.',
    inputSchema: { target: z.string() },
    outputSchema: TARGET_INSPECT_SCHEMA,
    annotations: READ,
  }, guarded('target_inspect', async ({ target }) => {
    require2('targets:read', target);
    const info = await executor.inspect(target);
    return { target, result: { id: info.id, running: info.running, workspace: info.workspace, image: info.image, status: info.status, source: info.source } };
  }));

  server.registerTool('fs_list', {
    title: 'List directory',
    description: 'List entries under a workspace-relative directory.',
    inputSchema: { target: z.string(), path: z.string().default(''), maxDepth: z.number().int().min(1).max(5).optional() },
    outputSchema: { entries: z.array(z.string()) },
    annotations: READ,
  }, guarded('fs_list', async ({ target, path, maxDepth }) => {
    require2('files:read', target);
    return { target, result: { entries: await executor.fsList(target, path ?? '', maxDepth) } };
  }));

  server.registerTool('fs_stat', {
    title: 'Stat path',
    description: 'Return type/size/mode/mtime for a workspace-relative path.',
    inputSchema: { target: z.string(), path: z.string() },
    outputSchema: FILE_STAT_SCHEMA,
    annotations: READ,
  }, guarded('fs_stat', async ({ target, path }) => {
    require2('files:read', target);
    return { target, result: await executor.fsStat(target, path) };
  }));

  server.registerTool('fs_read', {
    title: 'Read file',
    description: 'Read a UTF-8/binary file (base64) from the workspace.',
    inputSchema: { target: z.string(), path: z.string() },
    outputSchema: { path: z.string(), bytes: z.number().int().nonnegative(), content: z.string() },
    annotations: READ,
  }, guarded('fs_read', async ({ target, path }) => {
    require2('files:read', target);
    const { contentBase64, bytes } = await executor.fsRead(target, path);
    return { target, result: { path, bytes, content: Buffer.from(contentBase64, 'base64').toString('utf8') } };
  }));

  server.registerTool('fs_search', {
    title: 'Search files',
    description: 'Fixed-string recursive search under a workspace-relative path.',
    inputSchema: { target: z.string(), query: z.string().min(1), path: z.string().default(''), maxResults: z.number().int().min(1).max(1000).optional() },
    outputSchema: { matches: z.array(z.string()) },
    annotations: READ,
  }, guarded('fs_search', async ({ target, query, path, maxResults }) => {
    require2('files:read', target);
    return { target, result: { matches: await executor.fsSearch(target, path ?? '', query, maxResults) } };
  }));

  server.registerTool('fs_write', {
    title: 'Write file',
    description: 'Create or overwrite a file at a workspace-relative path.',
    inputSchema: { target: z.string(), path: z.string(), content: z.string() },
    outputSchema: OK_PATH_SCHEMA,
    annotations: WRITE,
  }, guarded('fs_write', async ({ target, path, content }) => {
    require2('files:write', target);
    await executor.fsWrite(target, path, Buffer.from(content, 'utf8').toString('base64'));
    return { target, result: { ok: true, path } };
  }));

  server.registerTool('fs_patch', {
    title: 'Patch file',
    description: 'Replace a unique exact substring (oldText) with newText in a file.',
    inputSchema: { target: z.string(), path: z.string(), oldText: z.string(), newText: z.string() },
    outputSchema: OK_PATH_SCHEMA,
    annotations: WRITE,
  }, guarded('fs_patch', async ({ target, path, oldText, newText }) => {
    require2('files:write', target);
    await executor.fsPatch(target, path, oldText, newText);
    return { target, result: { ok: true, path } };
  }));

  server.registerTool('fs_delete', {
    title: 'Delete path',
    description: 'Delete a file, or a directory when recursive=true. Destructive.',
    inputSchema: { target: z.string(), path: z.string(), recursive: z.boolean().default(false) },
    outputSchema: OK_PATH_SCHEMA,
    annotations: DESTRUCTIVE,
  }, guarded('fs_delete', async ({ target, path, recursive }) => {
    require2('files:delete', target);
    await executor.fsDelete(target, path, Boolean(recursive));
    return { target, result: { ok: true, path } };
  }));

  server.registerTool('terminal_exec', {
    title: 'Run a shell command in the target',
    description: 'Execute a shell command inside the authorized target container, confined to the workspace. Bounded by timeout and output size.',
    inputSchema: {
      target: z.string(),
      command: z.string().min(1),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    },
    outputSchema: EXEC_RESULT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, guarded('terminal_exec', async ({ target, command, cwd, timeoutMs }) => {
    const p = require2('terminal:exec', target);
    const res = await executor.execShell({ targetId: target, command, cwd, timeoutMs, principal: p.id });
    return { target, result: res };
  }));

  const gitTool = (name: string, argv: (path?: string) => string[], desc: string) =>
    server.registerTool(name, {
      title: name, description: desc,
      inputSchema: { target: z.string() },
      outputSchema: EXEC_RESULT_SCHEMA,
      annotations: READ,
    }, guarded(name, async ({ target }) => {
      const p = require2('git:read', target);
      const res = await executor.execArgv({ targetId: target, argv: argv(), principal: p.id });
      return { target, result: res };
    }));

  gitTool('git_status', () => ['git', 'status', '--porcelain=v1', '-b'], 'git status of the workspace');
  gitTool('git_diff', () => ['git', 'diff', '--stat'], 'git diff --stat of the workspace');
  gitTool('git_log', () => ['git', 'log', '--oneline', '-n', '30'], 'last 30 commits (oneline)');

  server.registerTool('process_list', {
    title: 'List processes',
    description: 'List running processes in the target container.',
    inputSchema: { target: z.string() },
    outputSchema: EXEC_RESULT_SCHEMA,
    annotations: READ,
  }, guarded('process_list', async ({ target }) => {
    const p = require2('process:read', target);
    const res = await executor.execArgv({ targetId: target, argv: ['ps', '-ef'], principal: p.id });
    if (res.exitCode !== 0) {
      const fallback = await executor.execArgv({ targetId: target, argv: ['ps', 'aux'], principal: p.id });
      return { target, result: fallback };
    }
    return { target, result: res };
  }));

  // Agent Control Plane (A2): activates exactly six of the nine contracts.
  // agent_diff / agent_apply / agent_discard remain contract-only until A6.
  registerAgentTools(server);

  return server;
}
