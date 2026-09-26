import { assertCsrf } from "../../../../server/product/authority/csrf";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../server/product/http/cookies";
import { failure, success } from "../../../../server/product/http/errors";
import { productProviderService } from "../../../../server/product/provider/runtime";
import type { ProviderKind } from "../../../../server/product/provider/types";
import { productSessionService } from "../../../../server/product/session/runtime";

export const dynamic = "force-dynamic";

const providerKinds = new Set<ProviderKind>(["kiro", "copilot"]);

export async function GET(request: Request): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    return success(await productProviderService().list(session));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const sessionId = parseCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    const session = productSessionService().current(sessionId);
    assertCsrf(request, session);
    const body = await request.json() as Record<string, unknown>;
    if (
      typeof body.kind !== "string" ||
      !providerKinds.has(body.kind as ProviderKind) ||
      typeof body.displayLabel !== "string" ||
      (body.displayHint !== undefined && typeof body.displayHint !== "string") ||
      (body.secretValue !== undefined && typeof body.secretValue !== "string")
    ) {
      throw new Error("provider_request_invalid");
    }
    const provider = await productProviderService().create(session, {
      kind: body.kind as ProviderKind,
      displayLabel: body.displayLabel,
      ...(typeof body.displayHint === "string" ? { displayHint: body.displayHint } : {}),
      ...(typeof body.secretValue === "string" ? { secretValue: body.secretValue } : {}),
    });
    return success(provider, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
