import "server-only";
import { ProductDataError } from "../data/errors";

export const MAX_TRANSIENT_AUDIO_BYTES = 52_428_800;
export const MAX_TRANSIENT_AUDIO_DURATION_SECONDS = 14_400;
export const ALLOWED_TRANSIENT_AUDIO_TYPES = new Set([
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
]);

export interface TransientAudioScope {
  organizationId: string;
  workspaceId: string;
  meetingId: string;
}

export interface TransientAudioChunk {
  contentType: string;
  bytes: Uint8Array;
  durationSeconds?: number;
}

export interface TransientAudioProcessor {
  status(): Promise<"AVAILABLE" | "NOT_AVAILABLE">;
  start(scope: TransientAudioScope): Promise<void>;
  accept(scope: TransientAudioScope, chunk: TransientAudioChunk): Promise<void>;
  stopAndVerifyCleanup(scope: TransientAudioScope): Promise<{ cleanupVerified: boolean }>;
  cancelAndVerifyCleanup(scope: TransientAudioScope): Promise<{ cleanupVerified: boolean }>;
}

export function validateTransientAudioChunk(chunk: TransientAudioChunk): void {
  if (!ALLOWED_TRANSIENT_AUDIO_TYPES.has(chunk.contentType)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_audio_content_type_invalid");
  }
  if (chunk.bytes.byteLength < 1 || chunk.bytes.byteLength > MAX_TRANSIENT_AUDIO_BYTES) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_audio_size_invalid");
  }
  if (
    chunk.durationSeconds !== undefined &&
    (!Number.isFinite(chunk.durationSeconds) ||
      chunk.durationSeconds <= 0 ||
      chunk.durationSeconds > MAX_TRANSIENT_AUDIO_DURATION_SECONDS)
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "meeting_audio_duration_invalid");
  }
}

export class UnavailableTransientAudioProcessor implements TransientAudioProcessor {
  async status(): Promise<"NOT_AVAILABLE"> { return "NOT_AVAILABLE"; }
  async start(_scope: TransientAudioScope): Promise<void> {
    throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_transient_audio_unavailable");
  }
  async accept(_scope: TransientAudioScope, _chunk: TransientAudioChunk): Promise<void> {
    throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_transient_audio_unavailable");
  }
  async stopAndVerifyCleanup(_scope: TransientAudioScope): Promise<{ cleanupVerified: false }> {
    return { cleanupVerified: false };
  }
  async cancelAndVerifyCleanup(_scope: TransientAudioScope): Promise<{ cleanupVerified: false }> {
    return { cleanupVerified: false };
  }
}

export async function requireVerifiedCleanup(
  processor: TransientAudioProcessor,
  scope: TransientAudioScope,
  mode: "stop" | "cancel",
): Promise<void> {
  const result = mode === "stop"
    ? await processor.stopAndVerifyCleanup(scope)
    : await processor.cancelAndVerifyCleanup(scope);
  if (!result.cleanupVerified) {
    throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "meeting_audio_cleanup_unverified");
  }
}
