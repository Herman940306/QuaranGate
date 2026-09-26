import "server-only";
import { MeetingService } from "./service";
declare global { var __qgMeetingService: MeetingService | undefined; }
export function meetingService(): MeetingService {
  if (!globalThis.__qgMeetingService) globalThis.__qgMeetingService = new MeetingService();
  return globalThis.__qgMeetingService;
}
