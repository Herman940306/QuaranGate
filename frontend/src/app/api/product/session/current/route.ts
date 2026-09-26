import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../server/product/http/errors";
import { productSessionService } from "../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const id = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const service = productSessionService();
    return success(service.view(await service.currentResolved(id)));
  } catch (error) {
    return failure(error);
  }
}
