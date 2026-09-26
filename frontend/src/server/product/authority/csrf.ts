import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { ProductSession } from "../identity/types";

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requestOriginAllowed(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export function assertCsrf(request: Request, session: ProductSession): void {
  if (!requestOriginAllowed(request)) throw new Error("product_csrf_origin_denied");
  const token = request.headers.get("x-csrf-token");
  if (!token || !constantTimeEqual(token, session.csrfToken)) throw new Error("product_csrf_denied");
}
