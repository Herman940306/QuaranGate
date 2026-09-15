import { createHash } from 'node:crypto';
import path from 'node:path';
import { redact } from '../shared/redact.js';
import type { LifecycleAction } from './planner.js';
import type { LifecycleOperationState } from './engine.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const EXTRA_SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
];

export interface LifecycleEvidenceInput {
  operationId: string;
  action: LifecycleAction;
  state: LifecycleOperationState;
  planDigest: string;
  productVersion: string;
  errorCode?: string;
  detail?: string;
  paths?: string[];
}

export interface LifecycleEvidence {
  schemaVersion: 1;
  operationId: string;
  action: LifecycleAction;
  state: LifecycleOperationState;
  planDigest: string;
  productVersion: string;
  errorCode: string | null;
  detail: string;
  paths: Array<{ label: string; identityDigest: string }>;
}

function sanitizeDetail(input: string): string {
  let output = redact(input.replace(CONTROL, ' '));
  for (const pattern of EXTRA_SECRET_PATTERNS) output = output.replace(pattern, '[REDACTED]');
  return output.slice(0, 1024);
}

function pathIdentity(input: string): { label: string; identityDigest: string } {
  if (!path.isAbsolute(input) || CONTROL.test(input)) throw new Error('Evidence path must be absolute and control-character free');
  const normalized = path.normalize(input);
  return {
    label: path.basename(normalized).slice(0, 128),
    identityDigest: createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex'),
  };
}

export function createLifecycleEvidence(input: LifecycleEvidenceInput): LifecycleEvidence {
  if (!SAFE_ID.test(input.operationId)) throw new Error('Lifecycle evidence operation id is invalid');
  if (!SHA256.test(input.planDigest)) throw new Error('Lifecycle evidence plan digest is invalid');
  if (!SEMVER.test(input.productVersion)) throw new Error('Lifecycle evidence product version is invalid');
  if (input.errorCode !== undefined && !SAFE_ID.test(input.errorCode)) {
    throw new Error('Lifecycle evidence error code is invalid');
  }
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    action: input.action,
    state: input.state,
    planDigest: input.planDigest,
    productVersion: input.productVersion,
    errorCode: input.errorCode ?? null,
    detail: sanitizeDetail(input.detail ?? ''),
    paths: (input.paths ?? []).slice(0, 20).map(pathIdentity),
  };
}
