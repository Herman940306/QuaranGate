import "server-only";
import type { ProductContextAdapter } from "../adapters/workspace";
import { PostgresProductContextAdapter } from "../adapters/postgres-context";
import { ProductEventRepository } from "../collaboration/events";
import type { TransactionPool } from "../data/db";
import { withTransaction } from "../data/db";
import { ProductDataError } from "../data/errors";
import { productDataRepository, productPool } from "../data/runtime";
import type { EffectiveProductRole } from "../data/types";
import type { ProductSession } from "../identity/types";
import {
  requireVerifiedCleanup,
  type TransientAudioChunk,
  type TransientAudioProcessor,
  type TransientAudioScope,
  UnavailableTransientAudioProcessor,
  validateTransientAudioChunk,
} from "./audio";
import { defaultMeetingAuditSink, type MeetingAuditSink } from "./audit";
import { MeetingRepository } from "./repository";
import {
  assertAnonymousSpeakerLabels,
  MEETING_TRANSCRIPT_EXPORT_PERMISSION,
  retainedUntilFromMinutes,
  transcriptContentReference,
  type TranscriptContentStore,
  UnavailableTranscriptContentStore,
} from "./transcript";
import {
  type MeetingTranscriptionProvider,
  type TranscriptionResult,
  UnavailableMeetingTranscriptionProvider,
} from "./transcription";
import type {
  MeetingActionItemsDto,
  MeetingDto,
  MeetingState,
  MeetingSummaryDto,
  TranscriptDto,
  TranscriptRetentionPolicyDto,
} from "./types";

const MEETING_RETENTION_MANAGE_PERMISSION = "product.meetings.retention.manage";

interface PermissionSource {
  effectiveProductRole(productUserId: string, workspaceId: string): Promise<EffectiveProductRole | undefined>;
}

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
    private readonly permissions?: PermissionSource,
    private readonly audio: TransientAudioProcessor = new UnavailableTransientAudioProcessor(),
    private readonly stt: MeetingTranscriptionProvider = new UnavailableMeetingTranscriptionProvider(),
    private readonly transcriptStore: TranscriptContentStore = new UnavailableTranscriptContentStore(),
    private readonly audit: MeetingAuditSink = defaultMeetingAuditSink,
  ) {}

  private async scope(session: ProductSession): Promise<{ organizationId: string; workspaceId: string }> {
    if (!session.workspace) throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_workspace_required");
    const workspace = await this.context.workspaceForUser(session.identity.userRef, session.workspace.id);
    if (!workspace || workspace.organizationId !== session.workspace.organizationId) {
      throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_forbidden");
    }
    return { organizationId: workspace.organizationId, workspaceId: workspace.id };
  }

  private async requirePermission(session: ProductSession, permission: string): Promise<void> {
    if (!session.workspace) throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_workspace_required");
    const source = this.permissions ?? productDataRepository().context;
    const role = await source.effectiveProductRole(session.identity.userRef, session.workspace.id);
    if (!role?.permissions.includes(permission)) {
      throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_permission_denied");
    }
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
        data: { state: value.state, recordingState: value.recordingState },
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

  async optInRecording(session: ProductSession, id: string, expectedVersion: number): Promise<MeetingDto> {
    const scope = await this.scope(session);
    assertVersion(expectedVersion);
    return withTransaction(this.pool, async (db) => {
      const repository = new MeetingRepository(db);
      const value = await repository.optInRecording(
        session.identity.userRef,
        scope.organizationId,
        scope.workspaceId,
        id,
        expectedVersion,
      );
      await new ProductEventRepository(db).append({
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        type: "meeting.recording_state_changed",
        actorProductUserId: session.identity.userRef,
        subjectType: "meeting",
        subjectId: id,
        aggregateVersion: value.version,
        correlationId: session.correlationId,
        data: { recordingState: value.recordingState, optIn: true },
      });
      return value;
    });
  }

  async attestRecording(
    session: ProductSession,
    id: string,
    input: { expectedVersion: number; persistentVisualNoticeAcknowledged: true },
  ): Promise<MeetingDto> {
    const scope = await this.scope(session);
    assertVersion(input.expectedVersion);
    if (input.persistentVisualNoticeAcknowledged !== true) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_notice_acknowledgement_required");
    }
    return withTransaction(this.pool, async (db) => {
      const repository = new MeetingRepository(db);
      const { meeting: value } = await repository.attestRecording(
        session.identity.userRef,
        scope.organizationId,
        scope.workspaceId,
        id,
        input.expectedVersion,
      );
      await new ProductEventRepository(db).append({
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        type: "meeting.recording_state_changed",
        actorProductUserId: session.identity.userRef,
        subjectType: "meeting",
        subjectId: id,
        aggregateVersion: value.version,
        correlationId: session.correlationId,
        data: {
          recordingState: value.recordingState,
          noticePolicy: value.noticePolicy,
          noticeState: value.noticeState,
        },
      });
      return value;
    });
  }

  async startRecording(session: ProductSession, id: string, expectedVersion: number): Promise<MeetingDto> {
    const scope = await this.scope(session);
    assertVersion(expectedVersion);
    const repository = new MeetingRepository(this.pool);
    const current = await repository.get(session.identity.userRef, scope.organizationId, scope.workspaceId, id);
    if (!current) throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "meeting_not_found");
    if (current.version !== expectedVersion) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "meeting_recording_start_stale");
    if (current.state !== "ACTIVE") throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_recording_meeting_not_active");
    if (!current.recordingOptIn || current.recordingState !== "READY") {
      throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_recording_precondition_opt_in_or_attestation_missing");
    }
    if (current.noticePolicy !== "PERSISTENT_VISUAL" || current.noticeState !== "CLIENT_ACKNOWLEDGED") {
      throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_recording_notice_precondition_missing");
    }
    const currentAttestation = await repository.latestAttestation(scope.organizationId, scope.workspaceId, id);
    if (
      !currentAttestation ||
      currentAttestation.meetingVersion !== current.version ||
      currentAttestation.policyVersion !== current.recordingPolicyVersion
    ) {
      throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_recording_attestation_stale_or_missing");
    }
    if (await this.audio.status() !== "AVAILABLE") {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_transient_audio_unavailable");
    }

    const audioScope: TransientAudioScope = { ...scope, meetingId: id };
    await this.audio.start(audioScope);
    try {
      return await withTransaction(this.pool, async (db) => {
        const value = await new MeetingRepository(db).setRecordingState(
          session.identity.userRef,
          scope.organizationId,
          scope.workspaceId,
          id,
          expectedVersion,
          ["READY"],
          "RECORDING",
        );
        await new ProductEventRepository(db).append({
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          type: "meeting.recording_state_changed",
          actorProductUserId: session.identity.userRef,
          subjectType: "meeting",
          subjectId: id,
          aggregateVersion: value.version,
          correlationId: session.correlationId,
          data: {
            recordingState: "RECORDING",
            noticePolicy: "PERSISTENT_VISUAL",
            noticeRequired: true,
          },
        });
        return value;
      });
    } catch (error) {
      await requireVerifiedCleanup(this.audio, audioScope, "cancel");
      throw error;
    }
  }

  async acceptTransientAudio(session: ProductSession, id: string, chunk: TransientAudioChunk): Promise<void> {
    const scope = await this.scope(session);
    const current = await new MeetingRepository(this.pool).get(
      session.identity.userRef,
      scope.organizationId,
      scope.workspaceId,
      id,
    );
    if (current?.recordingState !== "RECORDING") {
      throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_recording_not_active");
    }
    validateTransientAudioChunk(chunk);
    await this.audio.accept({ ...scope, meetingId: id }, chunk);
  }

  async stopRecording(session: ProductSession, id: string, expectedVersion: number): Promise<MeetingDto> {
    const scope = await this.scope(session);
    assertVersion(expectedVersion);
    const audioScope: TransientAudioScope = { ...scope, meetingId: id };

    const stopping = await withTransaction(this.pool, async (db) =>
      new MeetingRepository(db).setRecordingState(
        session.identity.userRef,
        scope.organizationId,
        scope.workspaceId,
        id,
        expectedVersion,
        ["RECORDING"],
        "STOPPING",
      )
    );

    try {
      await requireVerifiedCleanup(this.audio, audioScope, "stop");
    } catch (error) {
      try {
        await withTransaction(this.pool, async (db) =>
          new MeetingRepository(db).setRecordingState(
            session.identity.userRef,
            scope.organizationId,
            scope.workspaceId,
            id,
            stopping.version,
            ["STOPPING"],
            "FAILED",
          )
        );
      } catch {
        // Preserve the cleanup privacy failure as the primary result.
      }
      throw error;
    }

    return withTransaction(this.pool, async (db) => {
      const value = await new MeetingRepository(db).setRecordingState(
        session.identity.userRef,
        scope.organizationId,
        scope.workspaceId,
        id,
        stopping.version,
        ["STOPPING"],
        "STOPPED",
      );
      await new ProductEventRepository(db).append({
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        type: "meeting.recording_state_changed",
        actorProductUserId: session.identity.userRef,
        subjectType: "meeting",
        subjectId: id,
        aggregateVersion: value.version,
        correlationId: session.correlationId,
        data: { recordingState: "STOPPED", cleanupVerified: true },
      });
      return value;
    });
  }

  async transcriptRetentionPolicy(session: ProductSession): Promise<TranscriptRetentionPolicyDto | undefined> {
    const scope = await this.scope(session);
    return new MeetingRepository(this.pool).retentionPolicy(scope.organizationId, scope.workspaceId);
  }

  async configureTranscriptRetention(
    session: ProductSession,
    input: { enabled: boolean; retentionMinutes?: number; expectedVersion?: number },
  ): Promise<TranscriptRetentionPolicyDto> {
    const scope = await this.scope(session);
    await this.requirePermission(session, MEETING_RETENTION_MANAGE_PERMISSION);
    if (input.enabled && input.retentionMinutes === undefined) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_retention_policy_not_configured");
    }
    if (!input.enabled && input.retentionMinutes !== undefined) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_retention_duration_invalid");
    }
    if (input.retentionMinutes !== undefined) {
      retainedUntilFromMinutes(new Date(0), input.retentionMinutes);
    }
    return new MeetingRepository(this.pool).upsertRetentionPolicy(
      session.identity.userRef,
      scope.organizationId,
      scope.workspaceId,
      input,
    );
  }

  async persistQualifiedTranscript(
    session: ProductSession,
    id: string,
    result: TranscriptionResult,
    now = new Date(),
  ): Promise<TranscriptDto> {
    const scope = await this.scope(session);
    const current = await this.get(session, id);
    const policy = await new MeetingRepository(this.pool).retentionPolicy(scope.organizationId, scope.workspaceId);
    if (!policy?.enabled || policy.retentionMinutes === undefined) {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_retention_policy_not_configured");
    }
    if (this.stt.classification() !== "LOCAL_ONLY" || result.providerClass !== "LOCAL_ONLY") {
      throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_stt_provider_not_local");
    }
    if (result.state !== "COMPLETED" || typeof result.text !== "string" || result.text.length === 0) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_transcript_result_invalid");
    }
    if (result.text.length > 1_000_000) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_transcript_too_large");
    }
    const labels = [...new Set((result.segments ?? []).map((segment) => segment.speaker))];
    assertAnonymousSpeakerLabels(labels);
    if (await this.transcriptStore.status() !== "AVAILABLE") {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_transcript_store_unavailable");
    }

    const retainedUntil = retainedUntilFromMinutes(now, policy.retentionMinutes);
    const contentRef = transcriptContentReference();
    await this.transcriptStore.write({
      reference: contentRef,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      meetingId: current.id,
      content: result.text,
      retainedUntil,
    });
    try {
      const metadata = await new MeetingRepository(this.pool).insertTranscriptMetadata({
        meetingId: current.id,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        contentRef,
        retainedUntil,
        anonymousSpeakerLabels: labels,
      });
      return {
        meetingId: current.id,
        state: "COMPLETED",
        contentAvailable: true,
        retentionState: "CONFIGURED",
        retainedUntil: metadata.retainedUntil,
        transcriptVersion: metadata.transcriptVersion,
        providerClass: "LOCAL_ONLY",
        liveProviderQualification: "IMPLEMENTED_NOT_QUALIFIED",
        anonymousSpeakerLabels: labels,
      };
    } catch (error) {
      const cleanup = await this.transcriptStore.deleteAndVerify(contentRef);
      if (!cleanup.deletionVerified) {
        throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_transcript_cleanup_unverified");
      }
      throw error;
    }
  }

  async transcript(session: ProductSession, id: string): Promise<TranscriptDto> {
    const scope = await this.scope(session);
    const value = await this.get(session, id);
    const metadata = await new MeetingRepository(this.pool).currentTranscript(
      session.identity.userRef,
      scope.organizationId,
      scope.workspaceId,
      id,
    );
    const providerStatus = await this.stt.status();
    return {
      meetingId: value.id,
      state: metadata ? "COMPLETED" : value.transcriptionState,
      contentAvailable: Boolean(metadata),
      retentionState: metadata ? "CONFIGURED" : value.retentionState,
      ...(metadata ? {
        retainedUntil: metadata.retainedUntil,
        transcriptVersion: metadata.transcriptVersion,
      } : {}),
      providerClass: "LOCAL_ONLY",
      liveProviderQualification: providerStatus === "AVAILABLE"
        ? "IMPLEMENTED_NOT_QUALIFIED"
        : "UNAVAILABLE_NOT_CLAIMED",
      anonymousSpeakerLabels: metadata?.anonymousSpeakerLabels ?? [],
    };
  }

  async exportTranscript(
    session: ProductSession,
    id: string,
  ): Promise<{ content: string; filename: string; retainedUntil: string }> {
    const scope = await this.scope(session);
    await this.get(session, id);
    await this.requirePermission(session, MEETING_TRANSCRIPT_EXPORT_PERMISSION);
    const metadata = await new MeetingRepository(this.pool).currentTranscript(
      session.identity.userRef,
      scope.organizationId,
      scope.workspaceId,
      id,
    );
    if (!metadata) throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "meeting_transcript_not_found_or_expired");
    if (await this.transcriptStore.status() !== "AVAILABLE") {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_transcript_store_unavailable");
    }
    const content = await this.transcriptStore.read(metadata.contentRef);
    if (content.length > 1_000_000) {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_transcript_export_too_large");
    }
    this.audit({
      event: "meeting.transcript_exported",
      outcome: "allowed",
      correlationId: session.correlationId,
      productUserId: session.identity.userRef,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      meetingId: id,
      artifactType: "transcript",
      policyVersion: 1,
    });
    return {
      content,
      filename: `meeting-${id}-transcript.txt`,
      retainedUntil: metadata.retainedUntil,
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
      retentionMode: "EPHEMERAL_ONLY",
    };
  }

  async actionItems(session: ProductSession, id: string): Promise<MeetingActionItemsDto> {
    await this.get(session, id);
    return {
      meetingId: id,
      state: "NOT_AVAILABLE",
      items: [],
      executionAuthority: false,
      retentionMode: "EPHEMERAL_ONLY",
    };
  }
}
