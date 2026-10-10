/** HTTP client for the private executor service. */
import { request } from 'undici';
import { BridgeError } from '../shared/errors.js';
import { MAX_PROVIDER_RETRY_AFTER_MS } from '../shared/agents.js';
import type { ExecResult, FileStat, TargetInfo } from '../shared/types.js';
import type {
  SecurityAssessmentOperationalPreflight,
  SecurityAssessmentOperationalPreflightRequest,
} from '../shared/securityAssessment.js';
import type {
  GitHubBranchSummary, GitHubChecksSummary, GitHubCommentSummary, GitHubCommitSummary,
  GitHubIssueDetail, GitHubIssueSummary, GitHubPullFileSummary, GitHubPullReviewCommentSummary,
  GitHubPullReviewSummary, GitHubPullSummary, GitHubRepoMetadata, GitHubRepositorySummary, GitHubReviewEvent,
} from '../shared/github.js';

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
    const rawRetryAfterMs = json.retryAfterMs;
    const retryAfterMs = typeof rawRetryAfterMs === 'number'
      && Number.isSafeInteger(rawRetryAfterMs)
      && rawRetryAfterMs > 0
      ? Math.min(rawRetryAfterMs, MAX_PROVIDER_RETRY_AFTER_MS)
      : undefined;
    throw new BridgeError(
      (json.error ?? 'INTERNAL') as never,
      json.message ?? 'executor error',
      res.statusCode,
      retryAfterMs,
    );
  }
  return json as T;
}

export const executor = {
  listTargets: () => call<{ targets: TargetInfo[] }>('/targets').then((r) => r.targets),
  inspect: (targetId: string) => call<{ target: TargetInfo }>('/target/inspect', { targetId }).then((r) => r.target),
  targetLogs: (targetId: string, maxBytes?: number) =>
    call<{ target: string; stdout: string; stderr: string; bytes: number; truncated: boolean }>('/target/logs', { targetId, maxBytes }),
  targetControl: (targetId: string, action: 'start' | 'stop' | 'restart') =>
    call<{ ok: true; target: string; action: 'start' | 'stop' | 'restart'; running: boolean; status: string; health?: string }>('/target/control', { targetId, action }),
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
  controlCenterRuntime: () => call<ControlCenterRuntimeWire>('/control-center/runtime'),
  controlCenterExecutionFabric: () => call<{ executionFabric: ControlCenterExecutionFabricWire | null }>('/control-center/execution-fabric').then((r) => r.executionFabric),

  securityAssessmentReplayClaim: (req: {
    bridgeRequestId: string;
    nonce: string;
    assessmentId: string;
    assessmentVersion: number;
    expiresAt: string;
  }) => call<{ claimed: boolean }>('/security-assessment/replay/claim', req).then((r) => r.claimed),

  securityAssessmentPreflight: (req: SecurityAssessmentOperationalPreflightRequest) =>
    call<SecurityAssessmentOperationalPreflight>('/security-assessment/preflight', req),
  securityAssessmentPrepare: (req: SecurityAssessmentOperationalPreflightRequest) =>
    call<{ projectId: string; executionId: string; sourceRevision: string; sourceTree: string; manifestDigest: string }>(
      '/security-assessment/prepare',
      req,
    ),
  securityAssessmentRevalidate: (assessmentId: string) =>
    call<{
      schemaVersion: 'BE9_SOURCE_STAGE_V1';
      mode: 'stage' | 'verify';
      sourceRevision: string;
      sourceTree: string;
      fileCount: number;
      totalBytes: number;
      manifestBytes: number;
      manifestDigest: string;
    }>('/security-assessment/revalidate', { assessmentId }),
  securityAssessmentCleanup: (assessmentId: string, expectedExecutionId: string, uncertain = false) =>
    call<{ ok: true }>('/security-assessment/cleanup', { assessmentId, expectedExecutionId, uncertain }),

  // GitHub App control plane. Remote reads/PR actions use owner/repository
  // identifiers that are re-authorized against trusted accounts by the
  // executor. Direct Git push remains local-project driven.
  githubRepositories: () => call<{ repositories: GitHubRepositorySummary[] }>('/github/repositories').then((r) => r.repositories),
  githubRepository: (repository: string) => call<{ repository: GitHubRepoMetadata }>('/github/repository', { repository }).then((r) => r.repository),
  githubBranches: (repository: string, maxItems?: number) => call<{ branches: GitHubBranchSummary[] }>('/github/branches', { repository, maxItems }).then((r) => r.branches),
  githubCommits: (repository: string, ref: string, maxItems?: number) => call<{ commits: GitHubCommitSummary[] }>('/github/commits', { repository, ref, maxItems }).then((r) => r.commits),
  githubPulls: (repository: string, state?: 'open' | 'closed' | 'all', maxItems?: number) => call<{ pulls: GitHubPullSummary[] }>('/github/pulls', { repository, state, maxItems }).then((r) => r.pulls),
  githubPull: (repository: string, number: number) => call<{ pull: GitHubPullSummary }>('/github/pull', { repository, number }).then((r) => r.pull),
  githubPullFiles: (repository: string, number: number, maxItems?: number) => call<{ files: GitHubPullFileSummary[] }>('/github/pull/files', { repository, number, maxItems }).then((r) => r.files),
  githubIssues: (repository: string, state?: 'open' | 'closed' | 'all', maxItems?: number) => call<{ issues: GitHubIssueSummary[] }>('/github/issues', { repository, state, maxItems }).then((r) => r.issues),
  githubIssue: (repository: string, number: number) => call<{ issue: GitHubIssueDetail }>('/github/issue', { repository, number }).then((r) => r.issue),
  githubIssueComments: (repository: string, number: number, maxItems?: number) => call<{ comments: GitHubCommentSummary[] }>('/github/issue/comments', { repository, number, maxItems }).then((r) => r.comments),
  githubPullReviews: (repository: string, number: number, maxItems?: number) => call<{ reviews: GitHubPullReviewSummary[] }>('/github/pull/reviews', { repository, number, maxItems }).then((r) => r.reviews),
  githubPullReviewComments: (repository: string, number: number, maxItems?: number) => call<{ comments: GitHubPullReviewCommentSummary[] }>('/github/pull/review-comments', { repository, number, maxItems }).then((r) => r.comments),
  githubChecks: (repository: string, ref: string) => call<{ checks: GitHubChecksSummary }>('/github/checks', { repository, ref }).then((r) => r.checks),
  githubPush: (project: string, expectedHead: string, remoteBranch: string) => call<{ push: { project: string; remoteBranch: string; sha: string } }>('/github/push', { project, expectedHead, remoteBranch }).then((r) => r.push),
  githubPullCreate: (repository: string, req: { head: string; base: string; title: string; body?: string; draft?: boolean }) => call<{ pull: GitHubPullSummary }>('/github/pull/create', { repository, ...req }).then((r) => r.pull),
  githubPullUpdate: (repository: string, req: { number: number; title?: string; body?: string; state?: 'open' | 'closed' }) => call<{ pull: GitHubPullSummary }>('/github/pull/update', { repository, ...req }).then((r) => r.pull),
  githubPullReview: (repository: string, req: { number: number; event: GitHubReviewEvent; body?: string }) => call<{ review: { id: number; state: string; htmlUrl?: string } }>('/github/pull/review', { repository, ...req }).then((r) => r.review),

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
  agentJobDiscard: (jobId: string, principal: string) =>
    call<{ job: AgentJobWire }>(`/agent/jobs/${jobId}/discard`, { principal }).then((r) => r.job),
  agentDiff: (req: { jobId: string; principal: string; path?: string; cursor?: string; maxBytes?: number }) =>
    call<{ diff: AgentDiffWire }>(`/agent/jobs/${req.jobId}/diff`, {
      principal: req.principal, path: req.path, cursor: req.cursor, maxBytes: req.maxBytes,
    }).then((r) => r.diff),
  agentApply: (req: { jobId: string; principal: string }) =>
    call<{ apply: AgentApplyResultWire; job: AgentJobWire }>(`/agent/jobs/${req.jobId}/apply`, { principal: req.principal }),
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

/** A6-B5 apply result. `status` mirrors the job's new public status (APPLIED on success). */
export interface AgentApplyResultWire {
  status: 'APPLIED';
  appliedAt: string;
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

/** A6-B4 bounded review chunk from the executor. Mirrors the public agentDiffOutput. */
export interface AgentDiffWire {
  jobId: string;
  diffHash: string;
  path?: string;
  chunk: string;
  chunkBytes: number;
  totalBytes: number;
  truncated: boolean;
  cursor?: string;
  artifactHash?: string;
  changeSetHash?: string;
  baseCommit?: string;
  contentComplete?: boolean;
  applicable?: boolean;
  reason?: string | null;
  opCount?: number;
  artifactBytes?: number;
}


export interface ControlCenterExecutionFabricWire {
  generation: number;
  cached: boolean;
  capacity: { maxConcurrency: number; maxQueuedPerProject: number };
  projects: Array<{ projectId: string; queued: number; active: number }>;
  heldResources: Array<{ resourceKey: string; jobId: string; projectId: string; state: 'ACTIVE' | 'UNCERTAIN' }>;
  waitingResources: Array<{ projectId: string; resourceKey: string; waitingJobs: number }>;
  globalExclusiveHeld: boolean;
}

export interface ControlCenterRuntimeWire {
  buildRevision: string;
  dockerReachable: boolean;
  dockerAuthority: boolean;
  readinessCode: string;
  agentControlConfigured: boolean;
  activeJobs: number;
  queuedJobs: number;
  ollama: {
    configured: boolean;
    endpointState: 'EXACT_LOCAL' | 'DRIFT' | 'NOT_CONFIGURED';
    modelQualifier?: string;
  };
  sessionContinuity: 'NOT_QUALIFIED';
  providerAdmissionControl: 'DEFERRED';
  ideSessionControl: 'NOT_CONFIGURED' | 'AVAILABLE_NOT_LIVE_QUALIFIED' | 'FAILED';
}
