import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../../../server/product/http/cookies";
import { failure } from "../../../../../../../server/product/http/errors";
import { meetingService } from "../../../../../../../server/product/meetings/runtime";
import { productSessionService } from "../../../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    const result = await meetingService().exportTranscript(session, (await context.params).id);
    return new Response(result.content, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
