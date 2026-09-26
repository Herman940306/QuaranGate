import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { QueryResultLike, TransactionPool } from "../../src/server/product/data/db";
import { MeetingService } from "../../src/server/product/meetings/service";
import {
  MAX_TRANSIENT_AUDIO_BYTES,
  requireVerifiedCleanup,
  validateTransientAudioChunk,
  type TransientAudioProcessor,
  type TransientAudioScope,
} from "../../src/server/product/meetings/audio";
import {
  assertAnonymousSpeakerLabels,
  MAX_TRANSCRIPT_RETENTION_MINUTES,
  retainedUntilFromMinutes,
  type TranscriptContentStore,
} from "../../src/server/product/meetings/transcript";
import type { MeetingTranscriptionProvider } from "../../src/server/product/meetings/transcription";

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

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const MEETING = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-09-26T10:00:00.000Z";

function meetingRow(input: Partial<Record<string, unknown>> = {}) {
  return {
    id: MEETING,
    organization_id: ORG,
    workspace_id: WS,
    created_by: USER,
    title: "Policy meeting",
    state: "ACTIVE",
    recording_state: "READY",
    recording_opt_in: true,
    notice_policy: "PERSISTENT_VISUAL",
    notice_state: "CLIENT_ACKNOWLEDGED",
    recording_policy_version: 1,
    transcription_state: "NOT_AVAILABLE",
    summary_state: "NOT_AVAILABLE",
    retention_state: "NOT_CONFIGURED",
    version: 3,
    created_at: NOW,
    updated_at: NOW,
    ...input,
  };
}

function participantRow() {
  return {
    meeting_id: MEETING,
    product_user_id: USER,
    role: "owner",
    consent_state: "OWNER_ATTESTATION_MODEL",
  };
}

function attestationRow(input: Partial<Record<string, unknown>> = {}) {
  return {
    meeting_id: MEETING,
    attesting_product_user_id: USER,
    attestation_code: "NOTICE_AND_CONSENT_OBLIGATIONS_ATTESTED_BY_MEETING_OWNER",
    policy_version: 1,
    meeting_version: 3,
    created_at: NOW,
    ...input,
  };
}

function retentionRow(minutes = 60) {
  return {
    organization_id: ORG,
    workspace_id: WS,
    enabled: true,
    retention_minutes: minutes,
    version: 0,
    updated_by: USER,
    updated_at: NOW,
  };
}

function transcriptRow(retainedUntil = "2026-09-26T11:00:00.000Z") {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    meeting_id: MEETING,
    organization_id: ORG,
    workspace_id: WS,
    transcript_version: 1,
    content_ref: "qg-transcript:66666666-6666-4666-8666-666666666666",
    retained_until: retainedUntil,
    provider_class: "LOCAL_ONLY",
    anonymous_speaker_labels: ["Speaker A", "Speaker B"],
    created_at: NOW,
    updated_at: NOW,
  };
}

function eventRow(state: string, sequence = 1) {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    organization_id: ORG,
    workspace_id: WS,
    event_type: "meeting.recording_state_changed",
    event_version: 1,
    actor_product_user_id: USER,
    subject_type: "meeting",
    subject_id: MEETING,
    aggregate_version: 4,
    stream_key: "workspace",
    sequence,
    correlation_id: "corr",
    payload: { recordingState: state },
    created_at: NOW,
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
  workspaceForUser: vi.fn(async () => session.workspace),
};

function permissionSource(allowed: string[] = []) {
  return {
    effectiveProductRole: vi.fn(async () => ({
      roleClassification: "member",
      permissions: allowed,
    })),
  };
}

class FakeAudio implements TransientAudioProcessor {
  starts = 0;
  accepts = 0;
  stops = 0;
  cancels = 0;
  constructor(
    private readonly available = true,
    private readonly cleanupVerified = true,
  ) {}
  async status() { return this.available ? "AVAILABLE" as const : "NOT_AVAILABLE" as const; }
  async start(_scope: TransientAudioScope) { this.starts += 1; }
  async accept(_scope: TransientAudioScope) { this.accepts += 1; }
  async stopAndVerifyCleanup(_scope: TransientAudioScope) {
    this.stops += 1;
    return { cleanupVerified: this.cleanupVerified };
  }
  async cancelAndVerifyCleanup(_scope: TransientAudioScope) {
    this.cancels += 1;
    return { cleanupVerified: this.cleanupVerified };
  }
}

class FakeTranscriptStore implements TranscriptContentStore {
  writes = 0;
  reads = 0;
  deletes = 0;
  content = "Speaker A: hello";
  constructor(private readonly available = true, private readonly deletionVerified = true) {}
  async status() { return this.available ? "AVAILABLE" as const : "NOT_AVAILABLE" as const; }
  async write() { this.writes += 1; }
  async read() { this.reads += 1; return this.content; }
  async deleteAndVerify() {
    this.deletes += 1;
    return { deletionVerified: this.deletionVerified };
  }
}

const localStt: MeetingTranscriptionProvider = {
  classification: () => "LOCAL_ONLY",
  status: async () => "IMPLEMENTED_NOT_QUALIFIED",
  transcribe: async () => ({
    state: "COMPLETED",
    text: "Speaker A: hello",
    segments: [{ speaker: "Speaker A", startMs: 0, endMs: 1000, text: "hello" }],
    providerClass: "LOCAL_ONLY",
    providerProvenance: "local-test",
  }),
};

describe("BE7 R1 recording policy", () => {
  it("recording cannot start without per-meeting opt-in", async () => {
    const pool = new ScriptedPool([
      { rows: [meetingRow({ recording_state: "DISABLED", recording_opt_in: false })], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
    ]);
    const service = new MeetingService(pool, context as never, permissionSource() as never, new FakeAudio(), localStt);
    await expect(service.startRecording(session as never, MEETING, 3))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
  });

  it("recording cannot start without current owner attestation", async () => {
    const pool = new ScriptedPool([
      { rows: [meetingRow()], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const service = new MeetingService(pool, context as never, permissionSource() as never, new FakeAudio(), localStt);
    await expect(service.startRecording(session as never, MEETING, 3))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
  });

  it("stale attestation version fails closed even for meeting owner", async () => {
    const pool = new ScriptedPool([
      { rows: [meetingRow()], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
      { rows: [attestationRow({ meeting_version: 2 })], rowCount: 1 },
    ]);
    const service = new MeetingService(pool, context as never, permissionSource(["product.meetings.transcript.export"]) as never, new FakeAudio(), localStt);
    await expect(service.startRecording(session as never, MEETING, 3))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
  });

  it("persistent visual notice acknowledgement is required but rendering is never claimed verified", async () => {
    const pool = new ScriptedPool([
      { rows: [meetingRow({ notice_state: "REQUIRED" })], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
    ]);
    const service = new MeetingService(pool, context as never, permissionSource() as never, new FakeAudio(), localStt);
    await expect(service.startRecording(session as never, MEETING, 3))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });

    const types = readFileSync(join(process.cwd(), "src/server/product/meetings/types.ts"), "utf8");
    expect(types).toContain('noticePolicy: NoticePolicy');
    expect(types).toContain('noticeRenderingVerified: false');
  });

  it("recording starts only after all prerequisites and emits metadata-only accepted event", async () => {
    const audio = new FakeAudio();
    const pool = new ScriptedPool([
      { rows: [meetingRow()], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
      { rows: [attestationRow()], rowCount: 1 },
      { rows: [meetingRow({ recording_state: "RECORDING", version: 4 })], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
      { rows: [{ sequence: 1 }], rowCount: 1 },
      { rows: [eventRow("RECORDING")], rowCount: 1 },
    ]);
    const service = new MeetingService(pool, context as never, permissionSource() as never, audio, localStt);
    const value = await service.startRecording(session as never, MEETING, 3);
    expect(value.recordingState).toBe("RECORDING");
    expect(value.noticePolicy).toBe("PERSISTENT_VISUAL");
    expect(value.noticeRenderingVerified).toBe(false);
    expect(audio.starts).toBe(1);
    const eventInsert = pool.calls.find((call) => call.text.includes("INSERT INTO product_events"));
    expect(JSON.stringify(eventInsert?.values)).not.toMatch(/audio|transcript|consent/i);
  });

  it("failed DB transition after transient start attempts verified cancellation cleanup", async () => {
    const audio = new FakeAudio(true, true);
    const pool = new ScriptedPool([
      { rows: [meetingRow()], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
      { rows: [attestationRow()], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const service = new MeetingService(pool, context as never, permissionSource() as never, audio, localStt);
    await expect(service.startRecording(session as never, MEETING, 3))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_STALE_VERSION" });
    expect(audio.cancels).toBe(1);
  });

  it("unverifiable transient cleanup fails closed", async () => {
    const audio = new FakeAudio(true, false);
    await expect(requireVerifiedCleanup(audio, { organizationId: ORG, workspaceId: WS, meetingId: MEETING }, "stop"))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_UNAVAILABLE" });
    expect(audio.stops).toBe(1);
  });

  it("transient audio input is bounded and content-type allowlisted", () => {
    expect(() => validateTransientAudioChunk({
      contentType: "audio/wav",
      bytes: new Uint8Array([1, 2, 3]),
      durationSeconds: 2,
    })).not.toThrow();
    expect(() => validateTransientAudioChunk({
      contentType: "application/octet-stream",
      bytes: new Uint8Array([1]),
    })).toThrow();
    expect(() => validateTransientAudioChunk({
      contentType: "audio/wav",
      bytes: new Uint8Array(MAX_TRANSIENT_AUDIO_BYTES + 1),
    })).toThrow();
  });
});

describe("BE7 R1 transcript policy and local-only STT", () => {
  it("no configured retention means no durable transcript write", async () => {
    const store = new FakeTranscriptStore();
    const pool = new ScriptedPool([
      { rows: [meetingRow()], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const service = new MeetingService(pool, context as never, permissionSource() as never, new FakeAudio(), localStt, store);
    await expect(service.persistQualifiedTranscript(session as never, MEETING, await localStt.transcribe({
      meetingId: MEETING,
      organizationId: ORG,
      workspaceId: WS,
      transientAudioSession: true,
    }), new Date(NOW))).rejects.toMatchObject({ code: "PRODUCT_DATA_UNAVAILABLE" });
    expect(store.writes).toBe(0);
  });

  it("configured bounded retention derives retainedUntil without a default duration", async () => {
    const store = new FakeTranscriptStore();
    const pool = new ScriptedPool([
      { rows: [meetingRow({ retention_state: "CONFIGURED" })], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
      { rows: [retentionRow(60)], rowCount: 1 },
      { rows: [{ next_version: 1 }], rowCount: 1 },
      { rows: [transcriptRow("2026-09-26T11:00:00.000Z")], rowCount: 1 },
    ]);
    const service = new MeetingService(pool, context as never, permissionSource() as never, new FakeAudio(), localStt, store);
    const result = await service.persistQualifiedTranscript(session as never, MEETING, await localStt.transcribe({
      meetingId: MEETING,
      organizationId: ORG,
      workspaceId: WS,
      transientAudioSession: true,
    }), new Date(NOW));
    expect(result.retainedUntil).toBe("2026-09-26T11:00:00.000Z");
    expect(result.providerClass).toBe("LOCAL_ONLY");
    expect(result.anonymousSpeakerLabels).toEqual(["Speaker A"]);
    expect(store.writes).toBe(1);
  });

  it("retention bounds reject unbounded or excessive duration", () => {
    expect(() => retainedUntilFromMinutes(new Date(NOW), MAX_TRANSCRIPT_RETENTION_MINUTES)).not.toThrow();
    expect(() => retainedUntilFromMinutes(new Date(NOW), MAX_TRANSCRIPT_RETENTION_MINUTES + 1)).toThrow();
    expect(() => retainedUntilFromMinutes(new Date(NOW), 0)).toThrow();
  });

  it("expired transcript is unavailable by repository contract", () => {
    const source = readFileSync(join(process.cwd(), "src/server/product/meetings/repository.ts"), "utf8");
    expect(source).toContain("mt.retained_until>CURRENT_TIMESTAMP");
  });

  it("STT boundary is local-only with no arbitrary URL, cloud fallback or executable input", () => {
    const source = readFileSync(join(process.cwd(), "src/server/product/meetings/transcription.ts"), "utf8");
    expect(source).toContain('"LOCAL_ONLY"');
    expect(source).not.toMatch(/providerUrl|modelUrl|targetUrl|baseUrl|fetch\(|cloud|executable/i);
  });

  it("diarization permits anonymous labels only and rejects real-name style labels", () => {
    expect(() => assertAnonymousSpeakerLabels(["Speaker A", "Speaker B"])).not.toThrow();
    expect(() => assertAnonymousSpeakerLabels(["Alice"])).toThrow();
    expect(() => assertAnonymousSpeakerLabels(["Speaker Alice"])).toThrow();
  });
});

describe("BE7 R1 export and ephemeral generated content", () => {
  it("export is forbidden without narrow product permission", async () => {
    const pool = new ScriptedPool([
      { rows: [meetingRow({ retention_state: "CONFIGURED" })], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
    ]);
    const service = new MeetingService(pool, context as never, permissionSource() as never, new FakeAudio(), localStt, new FakeTranscriptStore());
    await expect(service.exportTranscript(session as never, MEETING))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
  });

  it("cross-workspace export fails before permission/content access", async () => {
    const store = new FakeTranscriptStore();
    const service = new MeetingService(new ScriptedPool(), {
      resolveIdentity: vi.fn(),
      workspaceForUser: vi.fn(async () => undefined),
    } as never, permissionSource(["product.meetings.transcript.export"]) as never, new FakeAudio(), localStt, store);
    await expect(service.exportTranscript(session as never, MEETING))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
    expect(store.reads).toBe(0);
  });

  it("successful retained transcript export emits metadata audit without content", async () => {
    const store = new FakeTranscriptStore();
    const audit = vi.fn();
    const pool = new ScriptedPool([
      { rows: [meetingRow({ retention_state: "CONFIGURED" })], rowCount: 1 },
      { rows: [participantRow()], rowCount: 1 },
      { rows: [transcriptRow()], rowCount: 1 },
    ]);
    const service = new MeetingService(
      pool,
      context as never,
      permissionSource(["product.meetings.transcript.export"]) as never,
      new FakeAudio(),
      localStt,
      store,
      audit,
    );
    const result = await service.exportTranscript(session as never, MEETING);
    expect(result.content).toBe("Speaker A: hello");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      event: "meeting.transcript_exported",
      meetingId: MEETING,
      artifactType: "transcript",
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("Speaker A: hello");
  });

  it("raw audio and ephemeral generated content have no durable/export model", () => {
    const migration = readFileSync(join(process.cwd(), "src/server/product/meetings/migrations/0006_meeting_privacy_policy.sql"), "utf8");
    const service = readFileSync(join(process.cwd(), "src/server/product/meetings/service.ts"), "utf8");
    const routes = readFileSync(join(process.cwd(), "src/app/api/product/meetings/[id]/transcript/export/route.ts"), "utf8");
    expect(migration).not.toMatch(/raw_audio|audio_blob|voiceprint|biometric/i);
    expect(migration).not.toMatch(/summary_text|summary_body|action_item_text|action_item_body/i);
    expect(service).not.toMatch(/summaryText|actionItemText|training|modelImprovement/i);
    expect(routes).not.toMatch(/audio|summary|action-item/i);
  });
});
