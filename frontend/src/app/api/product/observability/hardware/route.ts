import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../server/product/http/errors";
import { observabilityService } from "../../../../../server/product/observability/runtime";
import { productSessionService } from "../../../../../server/product/session/runtime";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try { const session = productSessionService().current(parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE)); return success(await observabilityService().hardware(session)); } catch (error) { return failure(error); }
}
