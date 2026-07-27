/** Redaction helpers for audit logging. Never log raw credentials. */

const PATTERNS: RegExp[] = [
  /\bmcpb_[A-Za-z0-9_-]{8,}\b/g, // bridge API keys
  /(authorization\s*:\s*bearer\s+)[^\s"']+/gi,
  /((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*)[^\s"'&]+/gi,
  /(-p\s*)[^\s"']+/g, // common `mysql -p...` style (best effort)
];

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, (_m, pre) => `${pre ?? ''}[REDACTED]`);
  return out;
}
