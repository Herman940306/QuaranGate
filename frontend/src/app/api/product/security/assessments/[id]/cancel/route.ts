import { assertCsrf } from "../../../../../../../server/product/authority/csrf";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../../../server/product/http/errors";
import { parseAssessmentId } from "../../../../../../../server/product/security/request";
import { securityAssessmentService } from "../../../../../../../server/product/security/runtime";
import { productSessionService } from "../../../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const session = productSessionService().current(
      parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE),
    );
    assertCsrf(request, session);
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== 0) {
      throw new Error("security_request_invalid");
    }
    const assessmentId = parseAssessmentId((await context.params).id);
    return success(await securityAssessmentService().cancelAssessment(session, assessmentId));
  } catch (error) {
    return failure(error);
  }
}
