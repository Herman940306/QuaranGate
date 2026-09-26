import "server-only";
import type { ProductContextAdapter } from "../adapters/workspace";
import { PostgresProductContextAdapter } from "../adapters/postgres-context";
import { ProductEventRepository } from "../collaboration/events";
import type { TransactionPool } from "../data/db";
import { withTransaction } from "../data/db";
import { ProductDataError } from "../data/errors";
import { productDataRepository, productPool } from "../data/runtime";
import type { ProductSession } from "../identity/types";
import { MeetingRepository } from "./repository";
import type {
  MeetingActionItemsDto,
  MeetingDto,
  MeetingState,
  MeetingSummaryDto,
  TranscriptDto,
} from "./types";

const ALLOWED_TRANSITIONS: Record<MeetingState, readonly MeetingState[]> = {
  DRAFT: ["READY", "CANCELLED", "EXPIRED"],
  READY: ["ACTIVE", "CANCELLED", "EXPIRED"],
  ACTIVE: ["STOPPED", "FAILED", "CANCELLED"],
  STOPPED: ["PROCESSING", "COMPLETED", "FAILED", "EXPIRED"],
  PROCESSING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

function title(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > 160) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_title_invalid");
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code < 32 || code === 127) throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_title_invalid");
  }
  return normalized;
}

function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_version_invalid");
  }
}

function eventForTransition(from: MeetingState, to: MeetingState): "meeting.started" | "meeting.ended" | undefined {
  if (to === "ACTIVE" && from !== "ACTIVE") return "meeting.started";
  if (from === "ACTIVE" && ["STOPPED", "FAILED", "CANCELLED"].includes(to)) return "meeting.ended";
  return undefined;
}

export class MeetingService {
  constructor(
    private readonly pool: TransactionPool = productPool(),
    private readonly context: ProductContextAdapter = new PostgresProductContextAdapter(productDataRepository()),
  ) {}

  private async scope(session: ProductSession): Promise<{ organizationId: string; workspaceId: string }> {
    if (!session.workspace) throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_workspace_required");
    const workspace = await this.context.workspaceForUser(session.identity.userRef, session.workspace.id);
    if (!workspace || workspace.organizationId !== session.workspace.organizationId) {
      throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_forbidden");
    }
    return { organizationId: workspace.organizationId, workspaceId: workspace.id };
  }

  async list(session: ProductSession): Promise<MeetingDto[]> {
    const scope = await this.scope(session);
    return new MeetingRepository(this.pool).list(
      session.identity.userRef,
      scope.organizationId,
      scope.workspaceId,
    );
  }

  async get(session: ProductSession, id: string): Promise<MeetingDto> {
    const scope = await this.scope(session);
    const value = await new MeetingRepository(this.pool).get(
      session.identity.userRef,
      scope.organizationId,
      scope.workspaceId,
      id,
    );
    if (!value) throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "meeting_not_found");
    return value;
  }

  async create(session: ProductSession, input: { title: string }, idempotencyKey?: string): Promise<MeetingDto> {
    const scope = await this.scope(session);
    const safeTitle = title(input.title);
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_idempotency_invalid");
    }
    return withTransaction(this.pool, async (db) => {
      const value = await new MeetingRepository(db).create(
        session.identity.userRef,
        scope.organizationId,
        scope.workspaceId,
        safeTitle,
      );
      await new ProductEventRepository(db).append({
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        type: "meeting.created",
        actorProductUserId: session.identity.userRef,
        subjectType: "meeting",
        subjectId: value.id,
        aggregateVersion: value.version,
        correlationId: session.correlationId,
        data: { state: value.state },
        ...(idempotencyKey ? { idempotencyKey: `meeting:${idempotencyKey}` } : {}),
      });
      return value;
    });
  }

  async update(
    session: ProductSession,
    id: string,
    input: { title: string; state: MeetingState; expectedVersion: number },
  ): Promise<MeetingDto> {
    const scope = await this.scope(session);
    const safeTitle = title(input.title);
    assertVersion(input.expectedVersion);
    return withTransaction(this.pool, async (db) => {
      const repository = new MeetingRepository(db);
      const current = await repository.get(
        session.identity.userRef,
        scope.organizationId,
        scope.workspaceId,
        id,
      );
      if (!current) throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "meeting_not_found");
      if (current.version !== input.expectedVersion) {
        throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "meeting_update_stale");
      }
      if (input.state !== current.state && !ALLOWED_TRANSITIONS[current.state].includes(input.state)) {
        throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_state_transition_invalid");
      }
      const value = await repository.update(
        session.identity.userRef,
        scope.organizationId,
        scope.workspaceId,
        id,
        safeTitle,
        input.state,
        input.expectedVersion,
      );
      const eventType = eventForTransition(current.state, value.state);
      if (eventType) {
        await new ProductEventRepository(db).append({
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          type: eventType,
          actorProductUserId: session.identity.userRef,
          subjectType: "meeting",
          subjectId: value.id,
          aggregateVersion: value.version,
          correlationId: session.correlationId,
          data: { state: value.state },
        });
      }
      return value;
    });
  }

  async transcript(session: ProductSession, id: string): Promise<TranscriptDto> {
    const value = await this.get(session, id);
    return {
      meetingId: value.id,
      state: value.transcriptionState,
      contentAvailable: false,
      retentionState: value.retentionState,
      providerState: "NOT_AVAILABLE",
      liveProviderQualification: "UNAVAILABLE_NOT_CLAIMED",
    };
  }

  async summary(session: ProductSession, id: string): Promise<MeetingSummaryDto> {
    const value = await this.get(session, id);
    return {
      meetingId: value.id,
      state: value.summaryState,
      generated: false,
      reviewed: false,
      contentAvailable: false,
      authoritativeHumanDecision: false,
      retentionState: value.retentionState,
    };
  }

  async actionItems(session: ProductSession, id: string): Promise<MeetingActionItemsDto> {
    const value = await this.get(session, id);
    return {
      meetingId: value.id,
      state: "OWNER_DECISION_REQUIRED",
      items: [],
      executionAuthority: false,
      retentionState: value.retentionState,
    };
  }
}
