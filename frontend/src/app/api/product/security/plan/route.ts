import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../server/product/http/errors";
import { parseDiscoveryIdRequest } from "../../../../../server/product/security/request";
import { securityAssessmentService } from "../../../../../server/product/security/runtime";
import { productSessionService } from "../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const session = productSessionService().current(parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE));
    const discoveryId = parseDiscoveryIdRequest(await request.json());
    return success(await securityAssessmentService().createPlan(session, discoveryId), { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
