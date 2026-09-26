import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../../server/product/http/errors";
import { securityAssessmentService } from "../../../../../../server/product/security/runtime";
import type { SecurityDiscoveryInput } from "../../../../../../server/product/security/types";
import { productSessionService } from "../../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const session = productSessionService().current(parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE));
    const body = await request.json() as SecurityDiscoveryInput;
    return success(securityAssessmentService().discover(session, body), { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
