/** Structured JSON audit log with credential redaction and bounded in-memory observability. */
import { createHash, randomUUID } from "node:crypto";
import { redact } from "../shared/redact.js";

export interface AuditEntry {
  ts: string;
  reqId: string;
  principal: string | null;
  tool: string;
  target?: string | null;
  decision: "allow" | "deny";
  code?: string;
  durationMs?: number;
  detail?: string;
}

export interface AuditActivityQuery {
  principal: string;
  limit?: number;
  sinceMs?: number;
}

const MAX_ACTIVITY = 2048;
const MAX_RETENTION_MS = 24 * 60 * 60 * 1000;
const activity: AuditEntry[] = [];
let auditStreamId = randomUUID();
let auditSequence = 0;
let auditHeadHash: string | null = null;

interface AuditLogRecord {
  auditVersion: 1;
  streamId: string;
  sequence: number;
  previousHash: string | null;
  ts: string;
  reqId: string;
  principal: string | null;
  tool: string;
  target: string | null;
  decision: "allow" | "deny";
  code: string | null;
  durationMs: number | null;
  detail: string | null;
  entryHash: string;
}

function canonicalScalars(input: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function hashAuditRecord(input: Omit<AuditLogRecord, "entryHash">): string {
  return createHash("sha256").update(Buffer.from(canonicalScalars(input as unknown as Record<string, unknown>), "utf8")).digest("hex");
}

export function newReqId(): string {
  return randomUUID();
}

function prune(now = Date.now()): void {
  const cutoff = now - MAX_RETENTION_MS;
  while (activity.length && Date.parse(activity[0]!.ts) < cutoff) activity.shift();
  if (activity.length > MAX_ACTIVITY) activity.splice(0, activity.length - MAX_ACTIVITY);
}

export function audit(entry: Omit<AuditEntry, "ts">): void {
  const line: AuditEntry = { ts: new Date().toISOString(), ...entry };
  if (line.detail) line.detail = redact(line.detail).slice(0, 500);
  activity.push(line);
  prune();

  auditSequence += 1;
  const bound: Omit<AuditLogRecord, "entryHash"> = {
    auditVersion: 1,
    streamId: auditStreamId,
    sequence: auditSequence,
    previousHash: auditHeadHash,
    ts: line.ts,
    reqId: line.reqId,
    principal: line.principal,
    tool: line.tool,
    target: line.target ?? null,
    decision: line.decision,
    code: line.code ?? null,
    durationMs: line.durationMs ?? null,
    detail: line.detail ?? null,
  };
  const entryHash = hashAuditRecord(bound);
  auditHeadHash = entryHash;
  process.stdout.write(JSON.stringify({ ...bound, entryHash } satisfies AuditLogRecord) + "\n");
}

export function auditIntegrityState(): {
  scheme: "SHA256_CHAIN_V1";
  streamId: string;
  sequence: number;
  headHash: string | null;
} {
  return {
    scheme: "SHA256_CHAIN_V1",
    streamId: auditStreamId,
    sequence: auditSequence,
    headHash: auditHeadHash,
  };
}

/**
 * Bounded metadata-only activity for one authenticated principal.
 * Raw prompts, tool arguments, file contents, command output, credentials and
 * response bodies are never stored in this ring and therefore cannot be read here.
 */
export function queryAuditActivity(query: AuditActivityQuery): Omit<AuditEntry, "detail">[] {
  prune();
  const limit = Math.max(1, Math.min(query.limit ?? 100, 200));
  const since = Date.now() - Math.max(0, Math.min(query.sinceMs ?? MAX_RETENTION_MS, MAX_RETENTION_MS));
  return activity
    .filter((entry) => entry.principal === query.principal && Date.parse(entry.ts) >= since)
    .slice(-limit)
    .reverse()
    .map(({ detail: _detail, ...entry }) => entry);
}

export function auditActivityStats(principal: string, sinceMs = 60 * 60 * 1000): {
  retained: number;
  windowMs: number;
  total: number;
  allowed: number;
  denied: number;
  failures: number;
  p50Ms: number | null;
  p95Ms: number | null;
  topTools: Array<{ tool: string; count: number }>;
} {
  prune();
  const windowMs = Math.max(60_000, Math.min(sinceMs, MAX_RETENTION_MS));
  const since = Date.now() - windowMs;
  // Aggregates cover the entire retained principal-scoped window (up to the
  // 2,048-entry ring), while row queries remain independently capped at 200.
  const rows = activity.filter((entry) => entry.principal === principal && Date.parse(entry.ts) >= since);
  const durations = rows.map((r) => r.durationMs).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const percentile = (q: number): number | null => {
    if (!durations.length) return null;
    const idx = Math.min(durations.length - 1, Math.max(0, Math.ceil(q * durations.length) - 1));
    return durations[idx] ?? null;
  };
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.tool, (counts.get(row.tool) ?? 0) + 1);
  return {
    retained: activity.filter((r) => r.principal === principal).length,
    windowMs,
    total: rows.length,
    allowed: rows.filter((r) => r.decision === "allow").length,
    denied: rows.filter((r) => r.decision === "deny").length,
    failures: rows.filter((r) => r.code !== undefined).length,
    p50Ms: percentile(0.50),
    p95Ms: percentile(0.95),
    topTools: [...counts.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)).slice(0, 10),
  };
}

/** Test-only reset; not reachable through runtime routes/tools. */
export function resetAuditActivityForTests(): void {
  activity.length = 0;
  auditStreamId = randomUUID();
  auditSequence = 0;
  auditHeadHash = null;
}
