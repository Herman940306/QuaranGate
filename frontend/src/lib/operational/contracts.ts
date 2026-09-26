import { OperationalError } from "./state";
import { record } from "./transport";
export function text(value: unknown, max = 256): string { if (typeof value !== "string" || value.length > max) throw new OperationalError("unknown"); return value; }
export function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new OperationalError("unknown"); return value; }
export function count(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new OperationalError("unknown"); return value; }
export function list<T>(value: unknown, decode: (row: Record<string, unknown>) => T, max = 256): T[] { if (!Array.isArray(value) || value.length > max) throw new OperationalError("unknown"); return value.map(row => decode(record(row))); }
function strings(value: unknown, max = 256): string[] { if (!Array.isArray(value) || value.length > max) throw new OperationalError("unknown"); return value.map(v => text(v, 512)); }
export interface Target { id: string; name: string; source: string; running: boolean; health: string }
export function targets(value: Record<string, unknown>): Target[] { return list(value.targets, row => ({ id: text(row.id), name: text(row.name), source: text(row.source), running: bool(row.running), health: "UNKNOWN" }), 10_000); }
export interface TargetDetail { id: string; running: boolean; status: string; health: string; source: string }
export function targetDetail(row: Record<string, unknown>): TargetDetail { return { id: text(row.id), running: bool(row.running), status: row.status === undefined ? "UNKNOWN" : text(row.status), health: row.health === undefined ? "UNKNOWN" : text(row.health), source: text(row.source) }; }
export interface Project { id: string; gitRequired: boolean; allowedBackends: string[]; allowedProfiles: string[] }
export function projects(value: Record<string, unknown>): Project[] { return list(value.projects, row => ({ id: text(row.id), gitRequired: bool(row.gitRequired), allowedBackends: strings(row.allowedBackends), allowedProfiles: strings(row.allowedProfiles) })); }
export interface Backend { id: string; available: boolean; profiles: string[] }
export function backends(value: Record<string, unknown>): Backend[] { return list(value.backends, row => ({ id: text(row.id), available: bool(row.available), profiles: strings(row.profiles) }), 16); }
export const jobStatuses = ["QUEUED", "PREPARING", "RUNNING", "VALIDATING", "COMPLETED", "FAILED_PRECONDITION", "FAILED_POLICY", "FAILED_AGENT", "FAILED_TIMEOUT", "FAILED_INFRASTRUCTURE", "CANCELLED", "APPLIED", "DISCARDED"] as const;
export type JobStatus = typeof jobStatuses[number];
function status(value: unknown): JobStatus { if (!jobStatuses.includes(value as JobStatus)) throw new OperationalError("unknown"); return value as JobStatus; }
export interface Job { jobId: string; status: JobStatus; createdAt: string; startedAt?: string; completedAt?: string; failureCode?: string }
export function job(row: Record<string, unknown>): Job { return { jobId: text(row.jobId, 36), status: status(row.status), createdAt: text(row.createdAt, 64), startedAt: row.startedAt === undefined ? undefined : text(row.startedAt, 64), completedAt: row.completedAt === undefined ? undefined : text(row.completedAt, 64), failureCode: row.failureCode === undefined ? undefined : text(row.failureCode, 64) }; }
// Deliberate metadata projection: summary/progress/provider prose/transcripts are never rendered.
export interface JobResult { jobId: string; status: JobStatus; backend: string; project: string; profile: string; exitCode: number | null; changedFiles: string[]; diffHash?: string }
export function jobResult(row: Record<string, unknown>): JobResult { return { jobId: text(row.jobId, 36), status: status(row.status), backend: text(row.backend), project: text(row.project), profile: text(row.profile), exitCode: row.exitCode === undefined ? null : exit(row.exitCode), changedFiles: row.changedFiles === undefined ? [] : strings(row.changedFiles, 1000), diffHash: row.diffHash === undefined ? undefined : hash(row.diffHash) }; }
function hash(value: unknown): string { const h = text(value, 64); if (!/^[a-f0-9]{64}$/.test(h)) throw new OperationalError("unknown"); return h; }
export interface JobDiff { jobId: string; diffHash: string; chunk: string; chunkBytes: number; totalBytes: number; truncated: boolean; applicable?: boolean; contentComplete?: boolean }
export function jobDiff(row: Record<string, unknown>): JobDiff { return { jobId: text(row.jobId, 36), diffHash: hash(row.diffHash), chunk: text(row.chunk, 262_144), chunkBytes: count(row.chunkBytes), totalBytes: count(row.totalBytes), truncated: bool(row.truncated), applicable: row.applicable === undefined ? undefined : bool(row.applicable), contentComplete: row.contentComplete === undefined ? undefined : bool(row.contentComplete) }; }
function exit(value: unknown): number | null { if (value === null) return null; if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new OperationalError("unknown"); return value; }
export interface GitOutput { exitCode: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; durationMs: number }
export function gitOutput(row: Record<string, unknown>): GitOutput { return { exitCode: exit(row.exitCode), stdout: text(row.stdout, 1_048_576), stderr: text(row.stderr, 1_048_576), truncated: bool(row.truncated), timedOut: bool(row.timedOut), durationMs: count(row.durationMs) }; }
export interface Repository { repository: string; owner: string; private: boolean; archived: boolean; localProject: string }
export function repositories(value: Record<string, unknown>): Repository[] { return list(value.repositories, row => ({ repository: text(row.repository), owner: text(row.owner), private: bool(row.private), archived: bool(row.archived), localProject: row.localProject === undefined ? "UNKNOWN" : text(row.localProject) }), 10_000); }
export const controlViews = ["summary", "authority", "topology", "providers", "capabilities", "recovery"] as const;
export type ControlView = typeof controlViews[number];
export interface MetadataRow { label: string; value: string }
export interface ControlSnapshot { view: ControlView; generatedAt: string; rows: MetadataRow[] }
export interface StatisticsSnapshot {
  view: "statistics";
  generatedAt: string;
  activity: {
    retained: number;
    windowMs: number;
    total: number;
    allowed: number;
    denied: number;
    failures: number;
    p50Ms: number | null;
    p95Ms: number | null;
    topTools: Array<{ tool: string; count: number }>;
  };
  jobs: { active: number | null; queued: number | null };
  targets: { visible: number; running: number };
  backends: { visible: number; available: number };
}
const metadataFields: Record<ControlView, string[]> = {
  summary: ["principal.id", "principal.name", "buildRevision", "targets.visible", "targets.running", "executor.dockerReachable", "executor.activeJobs", "executor.queuedJobs", "capabilityState.sessionContinuity", "capabilityState.providerAdmissionControl", "capabilityState.ideSessionControl"],
  authority: ["principal.id", "principal.name", "principal.scopes", "principal.targets", "principal.projects", "principal.agentBackends", "principal.agentProfiles", "principal.githubAccounts", "principal.githubProjects", "preflight.advisory", "preflight.evaluated"],
  topology: ["buildRevision", "provenance.gatewayRevision", "provenance.executorRevision", "provenance.state"],
  providers: ["activeJobs", "queuedJobs", "ollama.configured", "ollama.endpointState", "providerAdmissionControl", "sessionContinuity"],
  capabilities: [], recovery: ["startupRecovery", "providerSessionRecovery", "backups", "rollback", "ownerHost"],
};
function metadataValue(value: unknown): string {
  if (value === null || value === undefined) return "UNKNOWN";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return text(value, 256);
  if (Array.isArray(value) && value.length <= 256) return value.map(v => text(v)).join(", ") || "None exposed";
  throw new OperationalError("unknown");
}
function nullableCount(value: unknown): number | null {
  if (value === null) return null;
  return count(value);
}
function boundedWindow(value: unknown): number {
  const result = count(value);
  if (result < 60_000 || result > 86_400_000) throw new OperationalError("unknown");
  return result;
}
export function statistics(value: Record<string, unknown>): StatisticsSnapshot {
  if (value.view !== "statistics") throw new OperationalError("unknown");
  const data = record(value.data);
  const activity = record(data.activity);
  const jobs = record(data.jobs);
  const targets = record(data.targets);
  const backends = record(data.backends);
  const retained = count(activity.retained);
  const windowMs = boundedWindow(activity.windowMs);
  const total = count(activity.total);
  const allowed = count(activity.allowed);
  const denied = count(activity.denied);
  const failures = count(activity.failures);
  const p50Ms = nullableCount(activity.p50Ms);
  const p95Ms = nullableCount(activity.p95Ms);
  const topTools = list(activity.topTools, row => ({ tool: text(row.tool, 128), count: count(row.count) }), 10);
  const active = nullableCount(jobs.active);
  const queued = nullableCount(jobs.queued);
  const visibleTargets = count(targets.visible);
  const runningTargets = count(targets.running);
  const visibleBackends = count(backends.visible);
  const availableBackends = count(backends.available);
  if (retained > 2048 || total > retained || allowed + denied !== total || failures > total) throw new OperationalError("unknown");
  if (p50Ms !== null && p95Ms !== null && p50Ms > p95Ms) throw new OperationalError("unknown");
  if (topTools.reduce((sum, row) => sum + row.count, 0) > total) throw new OperationalError("unknown");
  if (runningTargets > visibleTargets || availableBackends > visibleBackends) throw new OperationalError("unknown");
  return {
    view: "statistics",
    generatedAt: text(value.generatedAt, 64),
    activity: { retained, windowMs, total, allowed, denied, failures, p50Ms, p95Ms, topTools },
    jobs: { active, queued },
    targets: { visible: visibleTargets, running: runningTargets },
    backends: { visible: visibleBackends, available: availableBackends },
  };
}
export function control(view: ControlView, value: Record<string, unknown>): ControlSnapshot {
  if (value.view !== view) throw new OperationalError("unknown");
  const data = record(value.data);
  const rows = metadataFields[view].map(label => {
    let field: unknown = data;
    for (const key of label.split(".")) field = field && typeof field === "object" ? (field as Record<string, unknown>)[key] : undefined;
    return { label, value: metadataValue(field) };
  });
  const array = view === "capabilities" ? "matrix" : view === "topology" ? "components" : view === "providers" || view === "summary" ? "backends" : undefined;
  const fields = view === "capabilities" ? ["component", "configured", "implementation", "productionQualification", "toolUse", "sessionResume"] : view === "topology" ? ["id", "role", "health", "dockerAuthority", "published", "buildRevision"] : ["id", "available", "profiles"];
  if (array && data[array] !== undefined) list(data[array], row => { for (const field of fields) rows.push({ label: `${metadataValue(row.id ?? row.component)} / ${field}`, value: metadataValue(row[field]) }); return null; });
  return { view, generatedAt: text(value.generatedAt, 64), rows };
}
