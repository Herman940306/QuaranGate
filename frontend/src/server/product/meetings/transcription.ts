import "server-only";

export interface TranscriptionRequest {
  meetingId: string;
  attachmentId: string;
  mimeType: string;
  languageHint?: string;
}

export interface TranscriptionResult {
  state: "COMPLETED" | "FAILED";
  transcriptReference?: string;
  providerProvenance: string;
  speakerLabelsAvailable: boolean;
}

export interface MeetingTranscriptionProvider {
  status(): Promise<"AVAILABLE" | "NOT_AVAILABLE">;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export class UnavailableMeetingTranscriptionProvider implements MeetingTranscriptionProvider {
  async status(): Promise<"NOT_AVAILABLE"> {
    return "NOT_AVAILABLE";
  }

  async transcribe(_request: TranscriptionRequest): Promise<TranscriptionResult> {
    throw new Error("meeting_stt_provider_unavailable");
  }
}
