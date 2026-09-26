import { assertCsrf } from "../../../../../server/product/authority/csrf";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../server/product/http/errors";
import { meetingService } from "../../../../../server/product/meetings/runtime";
import type { MeetingState } from "../../../../../server/product/meetings/types";
import { productSessionService } from "../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const STATES = new Set<MeetingState>([
  "DRAFT", "READY", "ACTIVE", "STOPPED", "PROCESSING",
  "COMPLETED", "FAILED", "CANCELLED", "EXPIRED",
]);

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    return success(await meetingService().get(session, (await context.params).id));
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    assertCsrf(request, session);
    const body = await request.json() as Record<string, unknown>;
    if (
      typeof body.title !== "string" ||
      typeof body.state !== "string" ||
      !STATES.has(body.state as MeetingState) ||
      !Number.isInteger(body.expectedVersion)
    ) {
      throw new Error("meeting_request_invalid");
    }
    return success(await meetingService().update(session, (await context.params).id, {
      title: body.title,
      state: body.state as MeetingState,
      expectedVersion: body.expectedVersion as number,
    }));
  } catch (error) {
    return failure(error);
  }
}
