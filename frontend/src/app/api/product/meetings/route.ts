import { assertCsrf } from "../../../../server/product/authority/csrf";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../server/product/http/cookies";
import { failure, success } from "../../../../server/product/http/errors";
import { meetingService } from "../../../../server/product/meetings/runtime";
import { productSessionService } from "../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    return success(await meetingService().list(session));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    assertCsrf(request, session);
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.title !== "string") throw new Error("meeting_request_invalid");
    return success(
      await meetingService().create(
        session,
        { title: body.title },
        request.headers.get("idempotency-key") ?? undefined,
      ),
      { status: 201 },
    );
  } catch (error) {
    return failure(error);
  }
}
