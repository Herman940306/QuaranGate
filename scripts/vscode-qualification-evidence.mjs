#!/usr/bin/env node

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const QUALIFICATION_RESULTS = Object.freeze([
  'PASS',
  'FAIL',
  'BLOCKED_ENVIRONMENT',
  'NOT_SUPPORTED',
  'NOT_RUN',
]);

export const MAX_EVIDENCE_STRING_BYTES = 2048;
export const MAX_ERROR_STRING_BYTES = 512;
export const MAX_EVIDENCE_ARRAY_ITEMS = 64;
export const MAX_EVIDENCE_OBJECT_KEYS = 64;
export const MAX_EVIDENCE_DEPTH = 5;

const SENSITIVE_KEY = /(?:secret|password|credential|authorization|authmac|access[_-]?token|refresh[_-]?token|bearer|prompt|raw[_-]?response|response[_-]?body|editor[_-]?buffer|file[_-]?content)/iu;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const STEP_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = '';
  let bytes = 0;
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > maxBytes) break;
    out += scalar;
    bytes += scalarBytes;
  }
  return out;
}

function sanitizeKey(key) {
  return truncateUtf8(String(key), 128);
}

export function sanitizeEvidence(value, depth = 0, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value === null || value === undefined) return value ?? null;
  if (depth >= MAX_EVIDENCE_DEPTH) return '[MAX_DEPTH]';

  if (typeof value === 'string') return truncateUtf8(value, MAX_EVIDENCE_STRING_BYTES);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    return value.slice(0, MAX_EVIDENCE_ARRAY_ITEMS).map((item) => sanitizeEvidence(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out = Object.create(null);
    for (const [rawKey, item] of Object.entries(value).slice(0, MAX_EVIDENCE_OBJECT_KEYS)) {
      const safeKey = sanitizeKey(rawKey);
      out[safeKey] = sanitizeEvidence(item, depth + 1, rawKey);
    }
    return out;
  }

  return truncateUtf8(String(value), MAX_EVIDENCE_STRING_BYTES);
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortCanonical(value), null, 2)}\n`;
}

export function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createQualificationStep({ id, result, observedAt, detail = {}, error = null }) {
  if (!STEP_ID.test(id)) throw new TypeError(`invalid qualification step id: ${id}`);
  if (!QUALIFICATION_RESULTS.includes(result)) throw new TypeError(`invalid qualification result: ${result}`);
  const at = observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new TypeError('observedAt must be ISO-8601 compatible');

  return Object.freeze({
    id,
    result,
    observedAt: at,
    detail: sanitizeEvidence(detail),
    error: error === null ? null : (() => {
      const code = String(error);
      if (!ERROR_CODE.test(code)) throw new TypeError('qualification error must be a bounded symbolic error code');
      return truncateUtf8(code, MAX_ERROR_STRING_BYTES);
    })(),
  });
}

export function createEvidenceManifest({ sourceCommit, runId, steps, environment = {}, generatedAt }) {
  if (!GIT_OBJECT_ID.test(sourceCommit)) throw new TypeError('sourceCommit must be a lowercase Git object id');
  if (typeof runId !== 'string' || runId.length < 1 || Buffer.byteLength(runId, 'utf8') > 128) {
    throw new TypeError('runId is invalid');
  }
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 256) throw new TypeError('steps must contain 1..256 entries');
  const normalizedSteps = steps.map((step) => createQualificationStep(step));
  const ids = new Set();
  for (const step of normalizedSteps) {
    if (ids.has(step.id)) throw new TypeError(`duplicate step id: ${step.id}`);
    ids.add(step.id);
  }
  const created = generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(created))) throw new TypeError('generatedAt must be ISO-8601 compatible');

  const manifest = {
    schema: 'quarangate.vscode-qualification-evidence.v1',
    sourceCommit,
    runId: truncateUtf8(runId, 128),
    generatedAt: created,
    environment: sanitizeEvidence(environment),
    steps: normalizedSteps.map((step) => sanitizeEvidence(step)),
  };
  const body = canonicalJson(manifest);
  return Object.freeze({
    ...manifest,
    manifestSha256: sha256Text(body),
  });
}

export async function writeEvidenceManifest(filePath, manifest) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, canonicalJson(manifest), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return resolved;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'));
}

function parseCli(argv) {
  const out = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!['--input', '--output'].includes(token)) throw new Error(`unsupported argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (out.has(token)) throw new Error(`duplicate argument: ${token}`);
    out.set(token, value);
    index += 1;
  }
  if (!out.has('--input')) throw new Error('--input is required');
  return { input: out.get('--input'), output: out.get('--output') ?? null };
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const raw = await readJson(args.input);
  const steps = (raw.steps ?? []).map((step) => createQualificationStep(step));
  const manifest = createEvidenceManifest({ ...raw, steps });
  if (args.output) {
    await writeEvidenceManifest(args.output, manifest);
  } else {
    process.stdout.write(canonicalJson(manifest));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`VSCODE_QUALIFICATION_EVIDENCE=FAIL ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
