import "server-only";
import { randomUUID } from "node:crypto";
import type { QueryExecutor } from "../data/db";
import { ProductDataError } from "../data/errors";
import type {
  MeetingDto,
  MeetingParticipantDto,
  MeetingState,
  RecordingAttestationDto,
  RecordingState,
  TranscriptMetadataDto,
  TranscriptRetentionPolicyDto,
} from "./types";

interface MeetingRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  workspace_id: string;
  created_by: string;
  title: string;
  state: MeetingState;
  recording_state: RecordingState;
  recording_opt_in: boolean;
  notice_policy: "PERSISTENT_VISUAL";
  notice_state: "REQUIRED" | "CLIENT_ACKNOWLEDGED";
  recording_policy_version: number | string;
  transcription_state: "NOT_AVAILABLE" | "PROCESSING" | "COMPLETED" | "FAILED";
  summary_state: "NOT_AVAILABLE" | "PROCESSING" | "COMPLETED" | "FAILED";
  retention_state: "NOT_CONFIGURED" | "CONFIGURED";
  version: number | string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ParticipantRow extends Record<string, unknown> {
  meeting_id: string;
  product_user_id: string;
  role: "owner" | "participant";
  consent_state: "OWNER_ATTESTATION_MODEL";
}

interface AttestationRow extends Record<string, unknown> {
  meeting_id: string;
  attesting_product_user_id: string;
  attestation_code: "NOTICE_AND_CONSENT_OBLIGATIONS_ATTESTED_BY_MEETING_OWNER";
  policy_version: number | string;
  meeting_version: number | string;
  created_at: string | Date;
}

interface RetentionPolicyRow extends Record<string, unknown> {
  organization_id: string;
  workspace_id: string;
  enabled: boolean;
  retention_minutes: number | null;
  version: number | string;
  updated_by: string;
  updated_at: string | Date;
}

interface TranscriptRow extends Record<string, unknown> {
  id: string;
  meeting_id: string;
  organization_id: string;
  workspace_id: string;
  transcript_version: number | string;
  content_ref: string;
  retained_until: string | Date;
  provider_class: "LOCAL_ONLY";
  anonymous_speaker_labels: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function participant(row: ParticipantRow): MeetingParticipantDto {
  return {
    productUserId: row.product_user_id,
    role: row.role,
    consentState: row.consent_state,
  };
}

function safeLabels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function meeting(row: MeetingRow, participants: MeetingParticipantDto[]): MeetingDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    title: row.title,
    state: row.state,
    recordingState: row.recording_state,
    recordingOptIn: row.recording_opt_in,
    recordingPolicyVersion: Number(row.recording_policy_version),
    noticePolicy: row.notice_policy,
    noticeState: row.notice_state,
    noticeRequired: true,
    noticeRenderingVerified: false,
    transcriptionState: row.transcription_state,
    summaryState: row.summary_state,
    retentionState: row.retention_state,
    version: Number(row.version),
    participants,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function attestation(row: AttestationRow): RecordingAttestationDto {
  return {
    meetingId: row.meeting_id,
    attestingProductUserId: row.attesting_product_user_id,
    attestationCode: row.attestation_code,
    policyVersion: Number(row.policy_version),
    meetingVersion: Number(row.meeting_version),
    createdAt: iso(row.created_at),
  };
}

function retentionPolicy(row: RetentionPolicyRow): TranscriptRetentionPolicyDto {
  return {
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    enabled: row.enabled,
    ...(row.retention_minutes !== null ? { retentionMinutes: row.retention_minutes } : {}),
    state: row.enabled && row.retention_minutes !== null ? "CONFIGURED" : "NOT_CONFIGURED",
    version: Number(row.version),
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  };
}

function transcript(row: TranscriptRow): TranscriptMetadataDto {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    transcriptVersion: Number(row.transcript_version),
    contentRef: row.content_ref,
    retainedUntil: iso(row.retained_until),
    providerClass: row.provider_class,
    anonymousSpeakerLabels: safeLabels(row.anonymous_speaker_labels),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class MeetingRepository {
  constructor(private readonly db: QueryExecutor) {}

  private async participantsFor(
    organizationId: string,
    workspaceId: string,
    meetingIds: string[],
  ): Promise<Map<string, MeetingParticipantDto[]>> {
    const grouped = new Map<string, MeetingParticipantDto[]>();
    if (meetingIds.length === 0) return grouped;
    const result = await this.db.query<ParticipantRow>(
      `SELECT meeting_id,product_user_id,role,consent_state
       FROM meeting_participants
       WHERE organization_id=$1 AND workspace_id=$2 AND meeting_id=ANY($3::uuid[])
       ORDER BY meeting_id,created_at,product_user_id`,
      [organizationId, workspaceId, meetingIds],
    );
    for (const row of result.rows) {
      const values = grouped.get(row.meeting_id) ?? [];
      values.push(participant(row));
      grouped.set(row.meeting_id, values);
    }
    return grouped;
  }

  async list(userId: string, organizationId: string, workspaceId: string): Promise<MeetingDto[]> {
    const result = await this.db.query<MeetingRow>(
      `SELECT ms.* FROM meeting_sessions ms
       JOIN meeting_participants mp
         ON mp.meeting_id=ms.id
        AND mp.organization_id=ms.organization_id
        AND mp.workspace_id=ms.workspace_id
       JOIN memberships m
         ON m.product_user_id=mp.product_user_id
        AND m.organization_id=ms.organization_id
        AND m.workspace_id=ms.workspace_id
        AND m.status='active'
       WHERE mp.product_user_id=$1
         AND ms.organization_id=$2
         AND ms.workspace_id=$3
       ORDER BY ms.updated_at DESC,ms.id DESC
       LIMIT 100`,
      [userId, organizationId, workspaceId],
    );
    const participantMap = await this.participantsFor(
      organizationId,
      workspaceId,
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) => meeting(row, participantMap.get(row.id) ?? []));
  }

  async get(userId: string, organizationId: string, workspaceId: string, id: string): Promise<MeetingDto | undefined> {
    const result = await this.db.query<MeetingRow>(
      `SELECT ms.* FROM meeting_sessions ms
       JOIN meeting_participants mp
         ON mp.meeting_id=ms.id
        AND mp.organization_id=ms.organization_id
        AND mp.workspace_id=ms.workspace_id
       JOIN memberships m
         ON m.product_user_id=mp.product_user_id
        AND m.organization_id=ms.organization_id
        AND m.workspace_id=ms.workspace_id
        AND m.status='active'
       WHERE mp.product_user_id=$1
         AND ms.organization_id=$2
         AND ms.workspace_id=$3
         AND ms.id=$4
       LIMIT 1`,
      [userId, organizationId, workspaceId, id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const participantMap = await this.participantsFor(organizationId, workspaceId, [id]);
    return meeting(row, participantMap.get(id) ?? []);
  }

  async create(
    userId: string,
    organizationId: string,
    workspaceId: string,
    title: string,
  ): Promise<MeetingDto> {
    const id = randomUUID();
    const result = await this.db.query<MeetingRow>(
      `INSERT INTO meeting_sessions(id,organization_id,workspace_id,created_by,title)
       SELECT $1,$2,$3,$4,$5
       FROM memberships m
       JOIN product_users u ON u.id=m.product_user_id AND u.status='active'
       JOIN workspaces w ON w.id=m.workspace_id AND w.organization_id=m.organization_id AND w.status='active'
       JOIN organizations o ON o.id=m.organization_id AND o.status='active'
       WHERE m.product_user_id=$4
         AND m.organization_id=$2
         AND m.workspace_id=$3
         AND m.status='active'
       RETURNING *`,
      [id, organizationId, workspaceId, userId, title],
    );
    const row = result.rows[0];
    if (!row) throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "meeting_create_denied");
    await this.db.query(
      `INSERT INTO meeting_participants(
         meeting_id,product_user_id,organization_id,workspace_id,role
       ) VALUES($1,$2,$3,$4,'owner')`,
      [id, userId, organizationId, workspaceId],
    );
    return meeting(row, [{ productUserId: userId, role: "owner", consentState: "OWNER_ATTESTATION_MODEL" }]);
  }

  async update(
    userId: string,
    organizationId: string,
    workspaceId: string,
    id: string,
    title: string,
    state: MeetingState,
    expectedVersion: number,
  ): Promise<MeetingDto> {
    const result = await this.db.query<MeetingRow>(
      `UPDATE meeting_sessions ms
       SET title=$1,state=$2,version=ms.version+1,updated_at=CURRENT_TIMESTAMP
       FROM meeting_participants mp
       WHERE ms.id=$3
         AND ms.organization_id=$4
         AND ms.workspace_id=$5
         AND ms.version=$6
         AND mp.meeting_id=ms.id
         AND mp.product_user_id=$7
         AND mp.organization_id=ms.organization_id
         AND mp.workspace_id=ms.workspace_id
         AND mp.role='owner'
       RETURNING ms.*`,
      [title, state, id, organizationId, workspaceId, expectedVersion, userId],
    );
    const row = result.rows[0];
    if (!row) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "meeting_update_stale_or_denied");
    const participantMap = await this.participantsFor(organizationId, workspaceId, [id]);
    return meeting(row, participantMap.get(id) ?? []);
  }

  async optInRecording(
    userId: string,
    organizationId: string,
    workspaceId: string,
    id: string,
    expectedVersion: number,
  ): Promise<MeetingDto> {
    const result = await this.db.query<MeetingRow>(
      `UPDATE meeting_sessions ms
       SET recording_opt_in=true,
           recording_state='OPTED_IN',
           notice_state='REQUIRED',
           version=ms.version+1,
           updated_at=CURRENT_TIMESTAMP
       FROM meeting_participants mp
       WHERE ms.id=$1
         AND ms.organization_id=$2
         AND ms.workspace_id=$3
         AND ms.version=$4
         AND ms.recording_state IN ('DISABLED','STOPPED')
         AND mp.meeting_id=ms.id
         AND mp.product_user_id=$5
         AND mp.role='owner'
       RETURNING ms.*`,
      [id, organizationId, workspaceId, expectedVersion, userId],
    );
    const row = result.rows[0];
    if (!row) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "meeting_recording_opt_in_stale_or_denied");
    const participantMap = await this.participantsFor(organizationId, workspaceId, [id]);
    return meeting(row, participantMap.get(id) ?? []);
  }

  async attestRecording(
    userId: string,
    organizationId: string,
    workspaceId: string,
    id: string,
    expectedVersion: number,
  ): Promise<{ meeting: MeetingDto; attestation: RecordingAttestationDto }> {
    const result = await this.db.query<MeetingRow>(
      `UPDATE meeting_sessions ms
       SET recording_state='READY',
           notice_state='CLIENT_ACKNOWLEDGED',
           version=ms.version+1,
           updated_at=CURRENT_TIMESTAMP
       FROM meeting_participants mp
       WHERE ms.id=$1
         AND ms.organization_id=$2
         AND ms.workspace_id=$3
         AND ms.version=$4
         AND ms.recording_opt_in=true
         AND ms.recording_state='OPTED_IN'
         AND mp.meeting_id=ms.id
         AND mp.product_user_id=$5
         AND mp.role='owner'
       RETURNING ms.*`,
      [id, organizationId, workspaceId, expectedVersion, userId],
    );
    const row = result.rows[0];
    if (!row) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "meeting_recording_attestation_stale_or_denied");
    const attestationResult = await this.db.query<AttestationRow>(
      `INSERT INTO meeting_recording_attestations(
         id,meeting_id,organization_id,workspace_id,attesting_product_user_id,
         attestation_code,policy_version,meeting_version
       ) VALUES(
         $1,$2,$3,$4,$5,
         'NOTICE_AND_CONSENT_OBLIGATIONS_ATTESTED_BY_MEETING_OWNER',$6,$7
       )
       RETURNING meeting_id,attesting_product_user_id,attestation_code,policy_version,meeting_version,created_at`,
      [randomUUID(), id, organizationId, workspaceId, userId, Number(row.recording_policy_version), Number(row.version)],
    );
    const attestationRow = attestationResult.rows[0];
    if (!attestationRow) throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_recording_attestation_write_failed");
    const participantMap = await this.participantsFor(organizationId, workspaceId, [id]);
    return { meeting: meeting(row, participantMap.get(id) ?? []), attestation: attestation(attestationRow) };
  }

  async latestAttestation(
    organizationId: string,
    workspaceId: string,
    id: string,
  ): Promise<RecordingAttestationDto | undefined> {
    const result = await this.db.query<AttestationRow>(
      `SELECT meeting_id,attesting_product_user_id,attestation_code,policy_version,meeting_version,created_at
       FROM meeting_recording_attestations
       WHERE meeting_id=$1 AND organization_id=$2 AND workspace_id=$3
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [id, organizationId, workspaceId],
    );
    return result.rows[0] ? attestation(result.rows[0]) : undefined;
  }

  async setRecordingState(
    userId: string,
    organizationId: string,
    workspaceId: string,
    id: string,
    expectedVersion: number,
    from: readonly RecordingState[],
    to: RecordingState,
  ): Promise<MeetingDto> {
    const result = await this.db.query<MeetingRow>(
      `UPDATE meeting_sessions ms
       SET recording_state=$1,
           version=ms.version+1,
           updated_at=CURRENT_TIMESTAMP
       FROM meeting_participants mp
       WHERE ms.id=$2
         AND ms.organization_id=$3
         AND ms.workspace_id=$4
         AND ms.version=$5
         AND ms.recording_state=ANY($6::text[])
         AND mp.meeting_id=ms.id
         AND mp.product_user_id=$7
         AND mp.role='owner'
       RETURNING ms.*`,
      [to, id, organizationId, workspaceId, expectedVersion, from, userId],
    );
    const row = result.rows[0];
    if (!row) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "meeting_recording_state_stale_or_denied");
    const participantMap = await this.participantsFor(organizationId, workspaceId, [id]);
    return meeting(row, participantMap.get(id) ?? []);
  }

  async retentionPolicy(
    organizationId: string,
    workspaceId: string,
  ): Promise<TranscriptRetentionPolicyDto | undefined> {
    const result = await this.db.query<RetentionPolicyRow>(
      `SELECT * FROM workspace_meeting_transcript_retention
       WHERE organization_id=$1 AND workspace_id=$2 LIMIT 1`,
      [organizationId, workspaceId],
    );
    return result.rows[0] ? retentionPolicy(result.rows[0]) : undefined;
  }

  async upsertRetentionPolicy(
    userId: string,
    organizationId: string,
    workspaceId: string,
    input: { enabled: boolean; retentionMinutes?: number; expectedVersion?: number },
  ): Promise<TranscriptRetentionPolicyDto> {
    const result = await this.db.query<RetentionPolicyRow>(
      `INSERT INTO workspace_meeting_transcript_retention(
         workspace_id,organization_id,enabled,retention_minutes,updated_by
       )
       SELECT $1,$2,$3,$4,$5 FROM memberships m
       WHERE m.product_user_id=$5
         AND m.organization_id=$2
         AND m.workspace_id=$1
         AND m.status='active'
       ON CONFLICT (workspace_id)
       DO UPDATE SET
         enabled=EXCLUDED.enabled,
         retention_minutes=EXCLUDED.retention_minutes,
         version=workspace_meeting_transcript_retention.version+1,
         updated_by=EXCLUDED.updated_by,
         updated_at=CURRENT_TIMESTAMP
       WHERE workspace_meeting_transcript_retention.organization_id=EXCLUDED.organization_id
         AND ($6::bigint IS NULL OR workspace_meeting_transcript_retention.version=$6)
       RETURNING *`,
      [workspaceId, organizationId, input.enabled, input.retentionMinutes ?? null, userId, input.expectedVersion ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "meeting_retention_policy_stale_or_denied");
    return retentionPolicy(row);
  }

  async insertTranscriptMetadata(input: {
    meetingId: string;
    organizationId: string;
    workspaceId: string;
    contentRef: string;
    retainedUntil: string;
    anonymousSpeakerLabels: string[];
  }): Promise<TranscriptMetadataDto> {
    const versionResult = await this.db.query<{ next_version: number | string }>(
      `SELECT COALESCE(MAX(transcript_version),0)+1 AS next_version
       FROM meeting_transcripts
       WHERE meeting_id=$1 AND organization_id=$2 AND workspace_id=$3`,
      [input.meetingId, input.organizationId, input.workspaceId],
    );
    const nextVersion = Number(versionResult.rows[0]?.next_version ?? 1);
    const result = await this.db.query<TranscriptRow>(
      `INSERT INTO meeting_transcripts(
         id,meeting_id,organization_id,workspace_id,transcript_version,
         content_ref,retained_until,provider_class,anonymous_speaker_labels
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'LOCAL_ONLY',$8::jsonb)
       RETURNING *`,
      [
        randomUUID(), input.meetingId, input.organizationId, input.workspaceId, nextVersion,
        input.contentRef, input.retainedUntil, JSON.stringify(input.anonymousSpeakerLabels),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_transcript_metadata_write_failed");
    return transcript(row);
  }

  async currentTranscript(
    userId: string,
    organizationId: string,
    workspaceId: string,
    meetingId: string,
  ): Promise<TranscriptMetadataDto | undefined> {
    const result = await this.db.query<TranscriptRow>(
      `SELECT mt.* FROM meeting_transcripts mt
       JOIN meeting_participants mp
         ON mp.meeting_id=mt.meeting_id
        AND mp.organization_id=mt.organization_id
        AND mp.workspace_id=mt.workspace_id
       WHERE mp.product_user_id=$1
         AND mt.organization_id=$2
         AND mt.workspace_id=$3
         AND mt.meeting_id=$4
         AND mt.retained_until>CURRENT_TIMESTAMP
       ORDER BY mt.transcript_version DESC
       LIMIT 1`,
      [userId, organizationId, workspaceId, meetingId],
    );
    return result.rows[0] ? transcript(result.rows[0]) : undefined;
  }
}
