import "server-only";
import { randomUUID } from "node:crypto";
import type { QueryExecutor } from "../data/db";
import { ProductDataError } from "../data/errors";
import type { ReplayPage, SafeProductEvent } from "./types";

interface EventRow extends Record<string, unknown> {
  id: string;
  event_type: string;
  event_version: number | string;
  actor_product_user_id: string | null;
  subject_type: string;
  subject_id: string;
  sequence: number | string;
  correlation_id: string;
  payload: Record<string, unknown>;
  created_at: string | Date;
}

const FORBIDDEN_KEY = /secret|token|credential|password|cookie|authorization|rawprompt|commandoutput|filecontents|scope|grant/i;
const SECRET_SHAPE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}/;

function assertSafeValue(value: unknown, depth = 0): void {
  if (depth > 6) throw new ProductDataError("PRODUCT_DATA_INVALID", "event_payload_too_deep");
  if (typeof value === "string") {
    if (value.length > 2048 || SECRET_SHAPE.test(value)) throw new ProductDataError("PRODUCT_DATA_INVALID", "event_payload_unsafe");
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > 64) throw new ProductDataError("PRODUCT_DATA_INVALID", "event_payload_too_large");
    for (const item of value) assertSafeValue(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 64) throw new ProductDataError("PRODUCT_DATA_INVALID", "event_payload_too_large");
    for (const [key, item] of entries) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(key) || FORBIDDEN_KEY.test(key)) {
        throw new ProductDataError("PRODUCT_DATA_INVALID", "event_payload_unsafe");
      }
      assertSafeValue(item, depth + 1);
    }
    return;
  }
  throw new ProductDataError("PRODUCT_DATA_INVALID", "event_payload_unsafe");
}

export function assertSafeEventPayload(payload: Record<string, unknown>): void {
  assertSafeValue(payload);
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 8192) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "event_payload_too_large");
  }
}

export function encodeReplayCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new ProductDataError("PRODUCT_DATA_INVALID", "event_cursor_invalid");
  return Buffer.from(`evt1:${sequence}`, "utf8").toString("base64url");
}

export function decodeReplayCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^evt1:(0|[1-9][0-9]*)$/.exec(decoded);
    if (!match) throw new Error("invalid");
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence)) throw new Error("invalid");
    return sequence;
  } catch {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "event_cursor_invalid");
  }
}

function safeEvent(row: EventRow): SafeProductEvent {
  return {
    eventId: row.id,
    type: row.event_type,
    version: Number(row.event_version),
    occurredAt: new Date(row.created_at).toISOString(),
    workspaceId: String((row as Record<string, unknown>).workspace_id ?? ""),
    ...(row.actor_product_user_id ? { actor: { productUserId: row.actor_product_user_id } } : {}),
    subject: { type: row.subject_type, id: row.subject_id },
    sequence: Number(row.sequence),
    correlationId: row.correlation_id,
    data: row.payload,
  };
}

export interface AppendEventInput {
  organizationId: string;
  workspaceId: string;
  type: string;
  actorProductUserId?: string;
  subjectType: string;
  subjectId: string;
  aggregateVersion: number;
  correlationId: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
  streamKey?: string;
}

export class ProductEventRepository {
  constructor(private readonly db: QueryExecutor) {}

  async append(input: AppendEventInput): Promise<SafeProductEvent> {
    const payload = input.data ?? {};
    assertSafeEventPayload(payload);
    const streamKey = input.streamKey ?? "workspace";
    if (!/^[a-z][a-z0-9_.:-]{0,95}$/.test(input.type) || !/^[a-z][a-z0-9_.:-]{0,95}$/.test(streamKey)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "event_contract_invalid");
    }
    if (input.idempotencyKey) {
      const existing = await this.db.query<EventRow>(
        `SELECT * FROM product_events
         WHERE workspace_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [input.workspaceId, input.idempotencyKey],
      );
      if (existing.rows[0]) return safeEvent(existing.rows[0]);
    }

    const sequenceResult = await this.db.query<{ sequence: number | string }>(
      `INSERT INTO product_event_sequences(organization_id, workspace_id, stream_key, next_sequence)
       VALUES ($1, $2, $3, 2)
       ON CONFLICT (workspace_id, stream_key)
       DO UPDATE SET next_sequence = product_event_sequences.next_sequence + 1
       RETURNING next_sequence - 1 AS sequence`,
      [input.organizationId, input.workspaceId, streamKey],
    );
    const sequence = Number(sequenceResult.rows[0]?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "event_sequence_unavailable");
    }

    const result = await this.db.query<EventRow>(
      `INSERT INTO product_events(
         id, organization_id, workspace_id, event_type, event_version,
         actor_product_user_id, subject_type, subject_id, aggregate_version,
         stream_key, sequence, correlation_id, idempotency_key, payload
       ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (workspace_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [
        randomUUID(), input.organizationId, input.workspaceId, input.type,
        input.actorProductUserId ?? null, input.subjectType, input.subjectId,
        input.aggregateVersion, streamKey, sequence, input.correlationId,
        input.idempotencyKey ?? null, JSON.stringify(payload),
      ],
    );
    if (result.rows[0]) return safeEvent(result.rows[0]);
    if (!input.idempotencyKey) throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "event_append_failed");
    const duplicate = await this.db.query<EventRow>(
      "SELECT * FROM product_events WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1",
      [input.workspaceId, input.idempotencyKey],
    );
    if (!duplicate.rows[0]) throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "event_append_failed");
    return safeEvent(duplicate.rows[0]);
  }

  async ensureDurableCursor(organizationId:string,workspaceId:string,consumerKey:string,streamKey="workspace"):Promise<{lastSequence:number;version:number}>{
    await this.db.query(
      `INSERT INTO product_event_replay_cursors(organization_id,workspace_id,consumer_key,stream_key)
       VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id,consumer_key,stream_key) DO NOTHING`,
      [organizationId,workspaceId,consumerKey,streamKey],
    );
    const cursor=await this.readDurableCursor(organizationId,workspaceId,consumerKey,streamKey);
    if(!cursor)throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE","event_cursor_unavailable");
    return cursor;
  }

  async readDurableCursor(organizationId:string,workspaceId:string,consumerKey:string,streamKey="workspace"):Promise<{lastSequence:number;version:number}|undefined>{
    const result=await this.db.query<{last_sequence:number|string;version:number|string}>(
      `SELECT last_sequence,version FROM product_event_replay_cursors
       WHERE organization_id=$1 AND workspace_id=$2 AND consumer_key=$3 AND stream_key=$4 LIMIT 1`,
      [organizationId,workspaceId,consumerKey,streamKey],
    );
    const row=result.rows[0];
    return row?{lastSequence:Number(row.last_sequence),version:Number(row.version)}:undefined;
  }

  async advanceDurableCursor(organizationId:string,workspaceId:string,consumerKey:string,lastSequence:number,expectedVersion:number,streamKey="workspace"):Promise<{lastSequence:number;version:number}>{
    if(!Number.isSafeInteger(lastSequence)||lastSequence<0||!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw new ProductDataError("PRODUCT_DATA_INVALID","event_cursor_invalid");
    const result=await this.db.query<{last_sequence:number|string;version:number|string}>(
      `UPDATE product_event_replay_cursors SET last_sequence=$1,version=version+1,updated_at=CURRENT_TIMESTAMP
       WHERE organization_id=$2 AND workspace_id=$3 AND consumer_key=$4 AND stream_key=$5 AND version=$6 AND last_sequence<=$1
       RETURNING last_sequence,version`,
      [lastSequence,organizationId,workspaceId,consumerKey,streamKey,expectedVersion],
    );
    const row=result.rows[0];
    if(!row)throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","event_cursor_stale");
    return{lastSequence:Number(row.last_sequence),version:Number(row.version)};
  }

  async replayForUser(productUserId: string, organizationId: string, workspaceId: string, cursor?: string, limit = 50): Promise<ReplayPage> {
    const after = decodeReplayCursor(cursor);
    const pageSize = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.db.query<EventRow>(
      `SELECT e.* FROM product_events e
       JOIN memberships m
         ON m.product_user_id = $1
        AND m.organization_id = e.organization_id
        AND m.workspace_id = e.workspace_id
        AND m.status = 'active'
       JOIN product_users u ON u.id = m.product_user_id AND u.status = 'active'
       JOIN workspaces w ON w.id = e.workspace_id AND w.organization_id = e.organization_id AND w.status = 'active'
       JOIN organizations o ON o.id = e.organization_id AND o.status = 'active'
       WHERE e.organization_id = $2
         AND e.workspace_id = $3
         AND e.sequence > $4
       ORDER BY e.sequence ASC, e.id ASC
       LIMIT $5`,
      [productUserId, organizationId, workspaceId, after, pageSize + 1],
    );
    const hasMore = result.rows.length > pageSize;
    const events = result.rows.slice(0, pageSize).map(safeEvent);
    const last = events.at(-1);
    return { events, ...(hasMore && last ? { nextCursor: encodeReplayCursor(last.sequence) } : {}) };
  }
}
