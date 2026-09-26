import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { QueryResultLike, TransactionPool } from "../../src/server/product/data/db";
import { readProductMigrationsThroughBe7 } from "../../src/server/product/meetings/migrations";
import { MeetingRepository } from "../../src/server/product/meetings/repository";
import { MeetingService } from "../../src/server/product/meetings/service";
import { UnavailableMeetingTranscriptionProvider } from "../../src/server/product/meetings/transcription";

type Call = { text: string; values?: readonly unknown[] };

class ScriptedPool implements TransactionPool {
  readonly calls: Call[] = [];
  constructor(private readonly responses: QueryResultLike<Record<string, unknown>>[] = []) {}
  async query<T>(text: string, values?: readonly unknown[]): Promise<QueryResultLike<T>> {
    this.calls.push({ text, values });
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as QueryResultLike<T>;
  }
  async connect() {
    const self = this;
    return {
      async query<T>(text: string, values?: readonly unknown[]): Promise<QueryResultLike<T>> {
        self.calls.push({ text, values });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [], rowCount: null } as QueryResultLike<T>;
        }
        return (self.responses.shift() ?? { rows: [], rowCount: 0 }) as QueryResultLike<T>;
      },
      release() {},
    } as never;
  }
}

const NOW = "2026-09-26T00:00:00.000Z";
const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const MEETING = "44444444-4444-4444-8444-444444444444";

function meetingRow(state = "DRAFT", version = 0) {
  return {
    id: MEETING,
    organization_id: ORG,
    workspace_id: WS,
    created_by: USER,
    title: "Weekly sync",
    state,
    recording_state: "OWNER_DECISION_REQUIRED",
    transcription_state: "NOT_AVAILABLE",
    summary_state: "NOT_AVAILABLE",
    retention_state: "OWNER_DECISION_REQUIRED",
    version,
    created_at: NOW,
    updated_at: NOW,
  };
}

function participantRow() {
  return {
    meeting_id: MEETING,
    product_user_id: USER,
    role: "owner",
    consent_state: "OWNER_DECISION_REQUIRED",
  };
}

const session = {
  id: "sid",
  identity: { userRef: USER, subject: "sub" },
  workspace: { id: WS, organizationId: ORG, name: "Workspace" },
  version: 1,
  issuedAt: 1,
  expiresAt: Date.now() + 60_000,
  correlationId: "corr",
  csrfToken: "csrf",
  principalMapping: { state: "unmapped" as const },
  oidcTokens: {},
};

const context = {
  resolveIdentity: vi.fn(),
  workspaceForUser: vi.fn(async (user: string, workspaceId: string) =>
    user === USER && workspaceId === WS ? session.workspace : undefined),
};

describe("BE7 data/privacy foundation", () => {
  it("composes accepted migrations through 0005", async () => {
    const migrations = await readProductMigrationsThroughBe7();
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5]);
    expect(migrations.at(-1)?.name).toBe("0005_meeting_foundation.sql");
    expect(migrations.every((migration) => /^[0-9a-f]{64}$/.test(migration.checksum))).toBe(true);
  });

  it("meeting schema stores metadata only and no raw audio/transcript/summary body or authority material", () => {
    const sql = readFileSync(join(process.cwd(), "src/server/product/meetings/migrations/0005_meeting_foundation.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE meeting_sessions");
    expect(sql).toContain("CREATE TABLE meeting_participants");
    expect(sql).toContain("CREATE TABLE meeting_attachment_links");
    expect(sql).toContain("OWNER_DECISION_REQUIRED");
    expect(sql).toContain("REFERENCES collaboration_attachments");
    expect(sql).not.toMatch(/audio_blob|audio_bytes|audio_storage|transcript_body|transcript_text|summary_body|summary_text|provider_secret|access_token|principal_ref|mcp_scope|target_grant|docker_authority/i);
  });

  it("list is participant and workspace scoped", async () => {
    const db = new ScriptedPool([
      { rows: [meetingRow()], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
    ]);
    const values = await new MeetingRepository(db).list(USER, ORG, WS);
    expect(values).toHaveLength(1);
    expect(values[0]?.participants[0]?.consentState).toBe("OWNER_DECISION_REQUIRED");
    expect(db.calls[0]?.values).toEqual([USER, ORG, WS]);
    expect(db.calls[0]?.text).toContain("meeting_participants");
    expect(db.calls[0]?.text).toContain("memberships");
  });

  it("cross-workspace meeting access returns no record", async () => {
    const db = new ScriptedPool([{ rows: [], rowCount: 0 }]);
    const value = await new MeetingRepository(db).get(USER, "other-org", "other-ws", MEETING);
    expect(value).toBeUndefined();
    expect(db.calls[0]?.values).toEqual([USER, "other-org", "other-ws", MEETING]);
  });

  it("creator is the only initial participant and consent is not fabricated", async () => {
    const db = new ScriptedPool([
      { rows: [meetingRow()], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const value = await new MeetingRepository(db).create(USER, ORG, WS, "Weekly sync");
    expect(value.participants).toEqual([{
      productUserId: USER,
      role: "owner",
      consentState: "OWNER_DECISION_REQUIRED",
    }]);
    expect(db.calls[1]?.text).toContain("meeting_participants");
    expect(db.calls[1]?.values?.[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.calls[1]?.values?.slice(1)).toEqual([USER, ORG, WS]);
  });

  it("cross-workspace service reads fail closed before database access", async () => {
    const pool = new ScriptedPool();
    const service = new MeetingService(pool, {
      resolveIdentity: vi.fn(),
      workspaceForUser: vi.fn(async () => undefined),
    } as never);
    await expect(service.get(session as never, MEETING))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
    expect(pool.calls).toHaveLength(0);
  });

  it("cross-workspace transcript access fails closed", async () => {
    const service = new MeetingService(new ScriptedPool(), {
      resolveIdentity: vi.fn(),
      workspaceForUser: vi.fn(async () => undefined),
    } as never);
    await expect(service.transcript(session as never, MEETING))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
  });

  it("transcript/summary/action-item DTOs contain no sensitive content and no execution authority", async () => {
    const pool = new ScriptedPool([
      { rows: [meetingRow()], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
      { rows: [meetingRow()], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
      { rows: [meetingRow()], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
    ]);
    const service = new MeetingService(pool, context as never);
    const transcript = await service.transcript(session as never, MEETING);
    const summary = await service.summary(session as never, MEETING);
    const actionItems = await service.actionItems(session as never, MEETING);
    expect(transcript).toMatchObject({
      state: "NOT_AVAILABLE",
      contentAvailable: false,
      providerState: "NOT_AVAILABLE",
      retentionState: "OWNER_DECISION_REQUIRED",
    });
    expect(summary).toMatchObject({
      generated: false,
      reviewed: false,
      contentAvailable: false,
      authoritativeHumanDecision: false,
    });
    expect(actionItems).toMatchObject({
      state: "OWNER_DECISION_REQUIRED",
      items: [],
      executionAuthority: false,
    });
    expect(JSON.stringify({ transcript, summary, actionItems })).not.toMatch(/transcriptBody|audio|prompt|token|credential/i);
  });

  it("STT provider is explicitly unavailable and never fabricates a transcript", async () => {
    const provider = new UnavailableMeetingTranscriptionProvider();
    await expect(provider.status()).resolves.toBe("NOT_AVAILABLE");
    await expect(provider.transcribe({
      meetingId: MEETING,
      attachmentId: "55555555-5555-4555-8555-555555555555",
      mimeType: "audio/wav",
    })).rejects.toThrow("meeting_stt_provider_unavailable");
  });

  it("service source emits only metadata meeting events and has no recording/transcription mutation", () => {
    const source = readFileSync(join(process.cwd(), "src/server/product/meetings/service.ts"), "utf8");
    expect(source).toContain('"meeting.created"');
    expect(source).toContain('"meeting.started"');
    expect(source).toContain('"meeting.ended"');
    expect(source).not.toMatch(/recordAudio|startRecording|uploadAudio|transcribe\(|transcriptBody|audioBlob|summaryBody/);
    expect(source).not.toMatch(/principalRef|scopes|targetGrants|githubAccounts|dockerAuthority/);
  });

  it("meeting state is distinct from recording/transcription/summary state", () => {
    const types = readFileSync(join(process.cwd(), "src/server/product/meetings/types.ts"), "utf8");
    expect(types).toContain("state: MeetingState");
    expect(types).toContain("recordingState: OwnerDecisionState");
    expect(types).toContain("transcriptionState: ProcessingState");
    expect(types).toContain("summaryState: ProcessingState");
  });

  it("invalid meeting state transition fails closed", async () => {
    const pool = new ScriptedPool([
      { rows: [meetingRow("DRAFT", 0)], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
    ]);
    const service = new MeetingService(pool, context as never);
    await expect(service.update(session as never, MEETING, {
      title: "Weekly sync",
      state: "COMPLETED",
      expectedVersion: 0,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });
    expect(pool.calls.some((call) => call.text.includes("UPDATE meeting_sessions"))).toBe(false);
  });
});
