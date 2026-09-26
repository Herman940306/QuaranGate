import { assertCsrf } from "../../../../../../../server/product/authority/csrf";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../../../server/product/http/errors";
import { meetingService } from "../../../../../../../server/product/meetings/runtime";
import { productSessionService } from "../../../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    assertCsrf(request, session);
    const body = await request.json() as Record<string, unknown>;
    if (!Number.isInteger(body.expectedVersion)) throw new Error("meeting_request_invalid");
    return success(await meetingService().stopRecording(
      session,
      (await context.params).id,
      body.expectedVersion as number,
    ));
  } catch (error) {
    return failure(error);
  }
}
