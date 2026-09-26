import { backends, bool, count, jobStatuses, projects, text, type Backend, type JobStatus, type Project } from "../../operational/contracts";
import { OperationalError } from "../../operational/state";
import { createMutator, createReader, type Transport } from "../../operational/transport";

const JOB_ID = /^job_[a-f0-9]{32}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function jobId(value: string): string { if (!JOB_ID.test(value)) throw new OperationalError("unknown"); return value; }
function projectId(value: string): string { if (!PROJECT_ID.test(value)) throw new OperationalError("unknown"); return value; }
function reference(value: string): string { if (!value || value.length > 128 || Array.from(value).some(char => char.charCodeAt(0) < 32)) throw new OperationalError("unknown"); return value; }
function promptText(value: string): string { if (!value.trim()) throw new OperationalError("unknown"); return text(value, 32_768); }
function status(value: unknown): JobStatus { if (!jobStatuses.includes(value as JobStatus)) throw new OperationalError("unknown"); return value as JobStatus; }
function hash(value: unknown): string { const v = text(value, 64); if (!/^[a-f0-9]{64}$/.test(v)) throw new OperationalError("unknown"); return v; }
function optionalText(value: unknown, max = 256): string | undefined { return value === undefined ? undefined : text(value, max); }
function optionalBool(value: unknown): boolean | undefined { return value === undefined ? undefined : bool(value); }
export interface DispatchIntent { project: string; backend: string; profile: string; resourcePolicy: string; prompt: string }
export interface DispatchReceipt { jobId: string; status: JobStatus; project: string; backend: string; profile: string; resourcePolicy: string; createdAt: string }
export interface JobState { jobId: string; status: JobStatus; createdAt: string; startedAt?: string; completedAt?: string; failureCode?: string; phase?: string; progress?: string }
export interface EvidenceRef { kind: "diff" | "result" | "transcript" | "log"; sha256: string; bytes: number }
export interface AgentResult { jobId: string; status: JobStatus; project: string; backend: string; profile: string; summary: string; exitCode: number | null; changedFiles: string[]; diffHash?: string; evidence: EvidenceRef[]; usageAvailable?: boolean }
export interface DiffChunk { jobId: string; diffHash: string; chunk: string; chunkBytes: number; totalBytes: number; truncated: boolean; cursor?: string; contentComplete?: boolean; applicable?: boolean; reason?: string | null; artifactHash?: string; changeSetHash?: string; baseCommit?: string }
export interface DispositionReceipt { jobId: string; status: JobStatus; project?: string; appliedAt?: string }
function dispatchReceipt(row: Record<string, unknown>, intent: DispatchIntent): DispatchReceipt {
  const result = { jobId: jobId(text(row.jobId, 36)), status: status(row.status), project: projectId(text(row.project, 64)), backend: text(row.backend, 128), profile: text(row.profile, 128), resourcePolicy: text(row.resourcePolicy, 128), createdAt: text(row.createdAt, 64) };
  if (result.project !== intent.project || result.backend !== intent.backend || result.profile !== intent.profile || result.resourcePolicy !== intent.resourcePolicy) throw new OperationalError("unknown");
  return result;
}
function jobState(row: Record<string, unknown>, id: string): JobState {
  if (row.jobId !== id) throw new OperationalError("unknown");
  return { jobId: id, status: status(row.status), createdAt: text(row.createdAt, 64), startedAt: optionalText(row.startedAt, 64), completedAt: optionalText(row.completedAt, 64), failureCode: optionalText(row.failureCode, 64), phase: optionalText(row.phase, 64), progress: optionalText(row.progress, 256) };
}
function agentResult(row: Record<string, unknown>, id: string): AgentResult {
  if (row.jobId !== id) throw new OperationalError("unknown");
  if (row.exitCode !== undefined && row.exitCode !== null && (typeof row.exitCode !== "number" || !Number.isSafeInteger(row.exitCode))) throw new OperationalError("unknown");
  if (row.changedFiles !== undefined && (!Array.isArray(row.changedFiles) || row.changedFiles.length > 1000)) throw new OperationalError("unknown");
  if (row.evidence !== undefined && (!Array.isArray(row.evidence) || row.evidence.length > 16)) throw new OperationalError("unknown");
  const evidence = (row.evidence ?? []) as Record<string, unknown>[];
  return { jobId: id, status: status(row.status), project: projectId(text(row.project, 64)), backend: text(row.backend, 128), profile: text(row.profile, 128), summary: text(row.summary, 16_384), exitCode: row.exitCode === undefined ? null : row.exitCode as number | null, changedFiles: ((row.changedFiles ?? []) as unknown[]).map(value => text(value, 512)), diffHash: row.diffHash === undefined ? undefined : hash(row.diffHash), evidence: evidence.map(ref => { if (!["diff", "result", "transcript", "log"].includes(String(ref.kind))) throw new OperationalError("unknown"); return { kind: ref.kind as EvidenceRef["kind"], sha256: hash(ref.sha256), bytes: count(ref.bytes) }; }), usageAvailable: row.usage && typeof row.usage === "object" && !Array.isArray(row.usage) ? bool((row.usage as Record<string, unknown>).usageAvailable) : undefined };
}
function diffChunk(row: Record<string, unknown>, id: string): DiffChunk {
  if (row.jobId !== id) throw new OperationalError("unknown");
  const reason = row.reason === null ? null : optionalText(row.reason, 4096);
  return { jobId: id, diffHash: hash(row.diffHash), chunk: text(row.chunk, 262_144), chunkBytes: count(row.chunkBytes), totalBytes: count(row.totalBytes), truncated: bool(row.truncated), cursor: optionalText(row.cursor, 256), contentComplete: optionalBool(row.contentComplete), applicable: optionalBool(row.applicable), reason, artifactHash: row.artifactHash === undefined ? undefined : hash(row.artifactHash), changeSetHash: row.changeSetHash === undefined ? undefined : hash(row.changeSetHash), baseCommit: optionalText(row.baseCommit, 40) };
}
function disposition(row: Record<string, unknown>, id: string, expected: JobStatus): DispositionReceipt {
  if (row.jobId !== id || status(row.status) !== expected) throw new OperationalError("unknown");
  return { jobId: id, status: expected, project: row.project === undefined ? undefined : projectId(text(row.project, 64)), appliedAt: optionalText(row.appliedAt, 64) };
}
export function createArenaClient(transport?: Transport) {
  const read = createReader(transport); const mutate = createMutator(transport);
  return {
    projects: (signal?: AbortSignal) => read("agent_projects", {}, projects, signal),
    backends: (signal?: AbortSignal) => read("agents_list", {}, backends, signal),
    dispatch: (intent: DispatchIntent, signal?: AbortSignal) => mutate("agent_dispatch", { project: projectId(intent.project), backend: reference(intent.backend), profile: reference(intent.profile), resourcePolicy: reference(intent.resourcePolicy), prompt: promptText(intent.prompt), sessionPolicy: "new" }, value => dispatchReceipt(value, intent), signal),
    status: (id: string, signal?: AbortSignal) => read("agent_status", { jobId: jobId(id) }, value => jobState(value, id), signal),
    result: (id: string, signal?: AbortSignal) => read("agent_result", { jobId: jobId(id) }, value => agentResult(value, id), signal),
    diff: (id: string, signal?: AbortSignal) => read("agent_diff", { jobId: jobId(id), maxBytes: 16_384 }, value => diffChunk(value, id), signal),
    cancel: (id: string, signal?: AbortSignal) => mutate("agent_cancel", { jobId: jobId(id) }, value => disposition(value, id, "CANCELLED"), signal),
    discard: (id: string, signal?: AbortSignal) => mutate("agent_discard", { jobId: jobId(id) }, value => disposition(value, id, "DISCARDED"), signal),
    apply: (id: string, signal?: AbortSignal) => mutate("agent_apply", { jobId: jobId(id) }, value => disposition(value, id, "APPLIED"), signal),
  };
}
export type ArenaClient = ReturnType<typeof createArenaClient>;
export type { Backend, Project };
