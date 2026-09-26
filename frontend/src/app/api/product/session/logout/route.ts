import { clearSessionCookie, parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../server/product/http/errors";
import { productSessionService } from "../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const secure = process.env.NODE_ENV === "production";
  try {
    const id = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    await productSessionService().logout(request, id);
    const response = success({ loggedOut: true });
    response.headers.append("Set-Cookie", clearSessionCookie(secure));
    return response;
  } catch (error) {
    return failure(error);
  }
}
