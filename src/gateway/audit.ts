/** Structured JSON audit log with credential redaction. */
import { randomUUID } from 'node:crypto';
import { redact } from '../shared/redact.js';

export interface AuditEntry {
  ts: string;
  reqId: string;
  principal: string | null;
  tool: string;
  target?: string | null;
  decision: 'allow' | 'deny';
  code?: string;
  durationMs?: number;
  detail?: string;
}

export function newReqId(): string {
  return randomUUID();
}

export function audit(entry: Omit<AuditEntry, 'ts'>): void {
  const line: AuditEntry = { ts: new Date().toISOString(), ...entry };
  if (line.detail) line.detail = redact(line.detail).slice(0, 500);
  process.stdout.write(JSON.stringify(line) + '\n');
}
