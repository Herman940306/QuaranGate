import { loginCookie } from "../../../../../server/product/http/cookies";
import { failure } from "../../../../../server/product/http/errors";
import { productSessionService } from "../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const { authorizationUrl, transaction } = await productSessionService().beginLogin();
    const response = Response.redirect(authorizationUrl, 302);
    response.headers.set("Cache-Control", "no-store");
    response.headers.append("Set-Cookie", loginCookie(transaction.id, Math.ceil((transaction.expiresAt - Date.now()) / 1000), process.env.NODE_ENV === "production"));
    return response;
  } catch (error) {
    return failure(error);
  }
}
