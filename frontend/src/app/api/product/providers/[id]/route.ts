import { assertCsrf } from "../../../../../server/product/authority/csrf";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../server/product/http/errors";
import { productProviderService } from "../../../../../server/product/provider/runtime";
import type { ProviderStatus } from "../../../../../server/product/provider/types";
import { productSessionService } from "../../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    return success(await productProviderService().get(session, (await context.params).id));
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    assertCsrf(request, session);
    const body = await request.json() as Record<string, unknown>;
    if (
      typeof body.displayLabel !== "string" ||
      (body.displayHint !== undefined && typeof body.displayHint !== "string") ||
      (body.status !== "enabled" && body.status !== "disabled") ||
      !Number.isInteger(body.expectedVersion)
    ) {
      throw new Error("provider_request_invalid");
    }
    return success(await productProviderService().update(session, (await context.params).id, {
      displayLabel: body.displayLabel,
      ...(typeof body.displayHint === "string" ? { displayHint: body.displayHint } : {}),
      status: body.status as ProviderStatus,
      expectedVersion: body.expectedVersion as number,
    }));
  } catch (error) {
    return failure(error);
  }
}
