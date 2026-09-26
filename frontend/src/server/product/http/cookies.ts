import "server-only";

export const PRODUCT_SESSION_COOKIE = "qg_product_session";
export const LOGIN_TRANSACTION_COOKIE = "qg_product_login";

export function parseCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function cookie(name: string, value: string, path: string, maxAge: number, secure: boolean): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Priority=High",
  ].filter(Boolean).join("; ");
}

export function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  return cookie(PRODUCT_SESSION_COOKIE, value, "/api/product", maxAge, secure);
}

export function loginCookie(value: string, maxAge: number, secure: boolean): string {
  return cookie(LOGIN_TRANSACTION_COOKIE, value, "/api/product/auth", maxAge, secure);
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

export function clearLoginCookie(secure: boolean): string {
  return loginCookie("", 0, secure);
}
