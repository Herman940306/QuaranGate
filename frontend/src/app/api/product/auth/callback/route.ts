import { failure, success } from "../../../../../server/product/http/errors";
import { clearLoginCookie, LOGIN_TRANSACTION_COOKIE, parseCookie, PRODUCT_SESSION_COOKIE, sessionCookie } from "../../../../../server/product/http/cookies";
import { productSessionService } from "../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const secure = process.env.NODE_ENV === "production";
  try {
    const transactionId = parseCookie(request.headers.get("cookie"), LOGIN_TRANSACTION_COOKIE);
    if (!transactionId) throw new Error("product_login_transaction_invalid");
    const priorSessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = await productSessionService().completeLogin(request, transactionId, priorSessionId);
    const response = success(productSessionService().view(session));
    response.headers.append("Set-Cookie", clearLoginCookie(secure));
    response.headers.append("Set-Cookie", sessionCookie(session.id, Math.ceil((session.expiresAt - Date.now()) / 1000), secure));
    return response;
  } catch (error) {
    const response = failure(error);
    response.headers.append("Set-Cookie", clearLoginCookie(secure));
    return response;
  }
}
