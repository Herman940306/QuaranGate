import "server-only";
import { ProductDataError } from "../data/errors";

export type ProductErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "STALE_VERSION"
  | "VALIDATION_FAILED"
  | "BACKEND_UNAVAILABLE"
  | "INTERNAL";

function mapError(error: unknown): { status: number; code: ProductErrorCode; message: string } {
  if (error instanceof ProductDataError) {
    if (error.code === "PRODUCT_DATA_STALE_VERSION") return { status: 409, code: "STALE_VERSION", message: "Product data version is stale." };
    if (error.code === "PRODUCT_DATA_FORBIDDEN") return { status: 403, code: "FORBIDDEN", message: "Request is not permitted." };
    if (error.code === "PRODUCT_DATA_NOT_FOUND") return { status: 404, code: "VALIDATION_FAILED", message: "Requested product data is unavailable." };
    if (error.code === "PRODUCT_DATA_UNAVAILABLE") return { status: 503, code: "BACKEND_UNAVAILABLE", message: "Product data service is unavailable." };
    return { status: 400, code: "VALIDATION_FAILED", message: "Product data request was rejected." };
  }
  const value = error instanceof Error ? error.message : "";
  if (value.includes("session_missing") || value.includes("session_invalid")) return { status: 401, code: "UNAUTHENTICATED", message: "Product session is not valid." };
  if (value.includes("csrf") || value.includes("workspace_forbidden")) return { status: 403, code: "FORBIDDEN", message: "Request is not permitted." };
  if (value.includes("stale_version")) return { status: 409, code: "STALE_VERSION", message: "Session version is stale." };
  if (value.includes("workspace_request") || value.includes("login_transaction") || value.includes("identity_")) return { status: 400, code: "VALIDATION_FAILED", message: "Identity/session request was rejected." };
  if (value.includes("not_configured") || value.includes("adapter_") || value.includes("non_durable")) return { status: 503, code: "BACKEND_UNAVAILABLE", message: "Product identity service is unavailable." };
  return { status: 500, code: "INTERNAL", message: "Request failed." };
}

function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  return headers;
}

export function success(data: unknown, init: ResponseInit = {}): Response {
  return Response.json({ data, meta: { serverTime: new Date().toISOString() } }, { ...init, headers: noStoreHeaders(init.headers) });
}

export function failure(error: unknown): Response {
  const mapped = mapError(error);
  return new Response(JSON.stringify({ error: { code: mapped.code, message: mapped.message } }), {
    status: mapped.status,
    headers: noStoreHeaders({ "Content-Type": "application/json" }),
  });
}
