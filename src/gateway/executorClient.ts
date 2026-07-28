/** HTTP client for the private executor service. */
import { request } from 'undici';
import { BridgeError } from '../shared/errors.js';
import type { ExecResult, FileStat, TargetInfo } from '../shared/types.js';

const BASE = process.env.EXECUTOR_URL ?? 'http://executor:8990';
const TOKEN = process.env.INTERNAL_TOKEN ?? '';

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await request(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-internal-token': TOKEN,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).catch((e) => {
    throw new BridgeError('DOCKER_UNAVAILABLE', `executor unreachable: ${e.message}`, 503);
  });
  const text = await res.body.text();
  const json = text ? JSON.parse(text) : {};
  if (res.statusCode >= 400) {
    throw new BridgeError((json.error ?? 'INTERNAL') as never, json.message ?? 'executor error', res.statusCode);
  }
  return json as T;
}

export const executor = {
  listTargets: () => call<{ targets: TargetInfo[] }>('/targets').then((r) => r.targets),
  inspect: (targetId: string) => call<{ target: TargetInfo }>('/target/inspect', { targetId }).then((r) => r.target),
  fsList: (targetId: string, path: string, maxDepth?: number) =>
    call<{ entries: string[] }>('/fs/list', { targetId, path, maxDepth }).then((r) => r.entries),
  fsStat: (targetId: string, path: string) => call<{ stat: FileStat }>('/fs/stat', { targetId, path }).then((r) => r.stat),
  fsRead: (targetId: string, path: string) =>
    call<{ contentBase64: string; bytes: number }>('/fs/read', { targetId, path }),
  fsSearch: (targetId: string, path: string, query: string, maxResults?: number) =>
    call<{ matches: string[] }>('/fs/search', { targetId, path, query, maxResults }).then((r) => r.matches),
  fsWrite: (targetId: string, path: string, contentBase64: string, mode?: number) =>
    call<{ ok: true }>('/fs/write', { targetId, path, contentBase64, mode }),
  fsPatch: (targetId: string, path: string, oldText: string, newText: string) =>
    call<{ ok: true }>('/fs/patch', { targetId, path, oldText, newText }),
  fsDelete: (targetId: string, path: string, recursive: boolean) =>
    call<{ ok: true }>('/fs/delete', { targetId, path, recursive }),
  execShell: (req: { targetId: string; command: string; cwd?: string; timeoutMs?: number; maxOutputBytes?: number; principal: string }) =>
    call<ExecResult>('/exec/shell', req),
  execArgv: (req: { targetId: string; argv: string[]; cwd?: string; timeoutMs?: number; principal: string }) =>
    call<ExecResult>('/exec/argv', req),
  reload: () => call<{ ok: true }>('/reload', {}),
  readyz: () => call<{ ok: true }>('/readyz').then(() => true).catch(() => false),

  // Agent Control Plane (A2). The executor independently re-validates and
  // enforces job ownership; the raw prompt is never returned by these calls.
  agentsList: () => call<{ backends: AgentBackendWire[] }>('/agents').then((r) => r.backends),
  agentProjects: () => call<{ projects: AgentProjectWire[] }>('/agent/projects').then((r) => r.projects),
  agentDispatch: (req: {
    principal: string; backend: string; project: string; profile: string;
    prompt: string; resourcePolicy?: string; sessionPolicy?: 'new' | 'resume';
  }) => call<{ job: AgentJobWire }>('/agent/jobs', req).then((r) => r.job),
  agentJob: (jobId: string, principal: string) =>
    call<{ job: AgentJobWire }>(`/agent/jobs/${jobId}?principal=${encodeURIComponent(principal)}`).then((r) => r.job),
  agentJobResult: (jobId: string, principal: string) =>
    call<{ job: AgentJobWire }>(`/agent/jobs/${jobId}/result?principal=${encodeURIComponent(principal)}`).then((r) => r.job),
  agentJobCancel: (jobId: string, principal: string) =>
    call<{ job: AgentJobWire }>(`/agent/jobs/${jobId}/cancel`, { principal }).then((r) => r.job),
};

export interface AgentBackendWire {
  id: string;
  available: boolean;
  profiles: string[];
}

export interface AgentProjectWire {
  id: string;
  gitRequired: boolean;
  allowedBackends: string[];
  allowedProfiles: string[];
}

export interface AgentJobWire {
  jobId: string;
  principalId: string;
  backend: string;
  project: string;
  profile: string;
  resourcePolicy: string;
  status: string;
  failureCode?: string;
  failureReason?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  promptHash: string;
  summary?: string;
  exitCode?: number;
  writer: boolean;
}
