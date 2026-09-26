import "server-only";
import { randomUUID } from "node:crypto";
import { ProductDataError } from "../data/errors";

export const MIN_TRANSCRIPT_RETENTION_MINUTES = 15;
export const MAX_TRANSCRIPT_RETENTION_MINUTES = 525_600;
export const MEETING_TRANSCRIPT_EXPORT_PERMISSION = "product.meetings.transcript.export";

export interface TranscriptContentStore {
  status(): Promise<"AVAILABLE" | "NOT_AVAILABLE">;
  write(input: {
    reference: string;
    organizationId: string;
    workspaceId: string;
    meetingId: string;
    content: string;
    retainedUntil: string;
  }): Promise<void>;
  read(reference: string): Promise<string>;
  deleteAndVerify(reference: string): Promise<{ deletionVerified: boolean }>;
}

export class UnavailableTranscriptContentStore implements TranscriptContentStore {
  async status(): Promise<"NOT_AVAILABLE"> { return "NOT_AVAILABLE"; }
  async write(): Promise<void> {
    throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_transcript_store_unavailable");
  }
  async read(): Promise<string> {
    throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_transcript_store_unavailable");
  }
  async deleteAndVerify(): Promise<{ deletionVerified: false }> {
    return { deletionVerified: false };
  }
}

export function transcriptContentReference(): string {
  return `qg-transcript:${randomUUID()}`;
}

export function retainedUntilFromMinutes(now: Date, retentionMinutes: number): string {
  if (
    !Number.isInteger(retentionMinutes) ||
    retentionMinutes < MIN_TRANSCRIPT_RETENTION_MINUTES ||
    retentionMinutes > MAX_TRANSCRIPT_RETENTION_MINUTES
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_retention_duration_invalid");
  }
  return new Date(now.getTime() + retentionMinutes * 60_000).toISOString();
}

export function assertAnonymousSpeakerLabels(labels: readonly string[]): void {
  if (labels.length > 64) throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_speaker_labels_invalid");
  const seen = new Set<string>();
  for (const label of labels) {
    if (!/^Speaker [A-Z]{1,2}$/.test(label) || seen.has(label)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_speaker_labels_invalid");
    }
    seen.add(label);
  }
}
