import "server-only";

export interface AnonymousSpeakerSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptionRequest {
  meetingId: string;
  organizationId: string;
  workspaceId: string;
  transientAudioSession: true;
  languageHint?: string;
}

export interface TranscriptionResult {
  state: "COMPLETED" | "FAILED";
  text?: string;
  segments?: AnonymousSpeakerSegment[];
  providerClass: "LOCAL_ONLY";
  providerProvenance: string;
}

export interface MeetingTranscriptionProvider {
  classification(): "LOCAL_ONLY";
  status(): Promise<"AVAILABLE" | "NOT_AVAILABLE" | "IMPLEMENTED_NOT_QUALIFIED">;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export class UnavailableMeetingTranscriptionProvider implements MeetingTranscriptionProvider {
  classification(): "LOCAL_ONLY" { return "LOCAL_ONLY"; }
  async status(): Promise<"NOT_AVAILABLE"> {
    return "NOT_AVAILABLE";
  }

  async transcribe(_request: TranscriptionRequest): Promise<TranscriptionResult> {
    throw new Error("meeting_stt_provider_unavailable");
  }
}
