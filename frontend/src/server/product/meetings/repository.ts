import "server-only";
import { randomUUID } from "node:crypto";
import type { QueryExecutor } from "../data/db";
import { ProductDataError } from "../data/errors";
import type { MeetingDto, MeetingParticipantDto, MeetingState } from "./types";

interface MeetingRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  workspace_id: string;
  created_by: string;
  title: string;
  state: MeetingState;
  recording_state: "OWNER_DECISION_REQUIRED";
  transcription_state: "NOT_AVAILABLE" | "PROCESSING" | "COMPLETED" | "FAILED";
  summary_state: "NOT_AVAILABLE" | "PROCESSING" | "COMPLETED" | "FAILED";
  retention_state: "OWNER_DECISION_REQUIRED";
  version: number | string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ParticipantRow extends Record<string, unknown> {
  meeting_id: string;
  product_user_id: string;
  role: "owner" | "participant";
  consent_state: "OWNER_DECISION_REQUIRED";
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

function meeting(row: MeetingRow, participants: MeetingParticipantDto[]): MeetingDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    title: row.title,
    state: row.state,
    recordingState: row.recording_state,
    transcriptionState: row.transcription_state,
    summaryState: row.summary_state,
    retentionState: row.retention_state,
    version: Number(row.version),
    participants,
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
    return meeting(row, [{ productUserId: userId, role: "owner", consentState: "OWNER_DECISION_REQUIRED" }]);
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
}
