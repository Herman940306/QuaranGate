import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../../server/product/http/errors";
import { parseDiscoveryId } from "../../../../../../server/product/security/request";
import { securityAssessmentService } from "../../../../../../server/product/security/runtime";
import { productSessionService } from "../../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const session = productSessionService().current(parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE));
    const discoveryId = parseDiscoveryId(new URL(request.url).searchParams.get("discoveryId"));
    return success(await securityAssessmentService().result(session, discoveryId));
  } catch (error) {
    return failure(error);
  }
}
