import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../../server/product/http/errors";
import { meetingService } from "../../../../../../server/product/meetings/runtime";
import { productSessionService } from "../../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    return success(await meetingService().summary(session, (await context.params).id));
  } catch (error) {
    return failure(error);
  }
}
