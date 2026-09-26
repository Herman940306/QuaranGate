import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../server/product/http/errors";
import { productSessionService } from "../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const id = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const body = await request.json() as { workspaceId?: unknown; expectedSessionVersion?: unknown };
    if (typeof body.workspaceId !== "string" || !body.workspaceId || !Number.isInteger(body.expectedSessionVersion)) {
      throw new Error("product_workspace_request_invalid");
    }
    const session = await productSessionService().switchWorkspace(request, id, body.workspaceId, body.expectedSessionVersion as number);
    return success(productSessionService().view(session));
  } catch (error) {
    return failure(error);
  }
}
