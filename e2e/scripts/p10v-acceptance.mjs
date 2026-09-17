#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { externalOutputPath, pathIsWithinRoot } from '../../scripts/release-path-safety.mjs';

const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readJson(path, label) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`${label} must be valid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function listEvidenceFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = resolve(dir, entry.name);
    const rel = relative(root, absolute).split(sep).join('/');
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`P10-V evidence contains a symlink after finalization: ${rel}`);
    if (entry.isDirectory()) { listEvidenceFiles(root, absolute, out); continue; }
    if (!entry.isFile()) throw new Error(`P10-V evidence contains a non-regular artifact after finalization: ${rel}`);
    if (info.size <= 0 || info.size > MAX_FILE_BYTES) throw new Error(`P10-V evidence artifact size is invalid after finalization: ${rel}`);
    out.push(rel);
    if (out.length > MAX_FILES + 3) throw new Error('P10-V post-finalization file-count bound exceeded');
  }
  return out;
}

function verifyFinalizedBytes(root, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_FILES) throw new Error('P10-V manifest file list is invalid');
  const manifestPaths = [];
  let previous = null;
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('P10-V manifest file entry is invalid');
    if (typeof entry.path !== 'string' || !entry.path || entry.path.startsWith('/') || entry.path.includes('..') || entry.path.includes('\\')) throw new Error('P10-V manifest path is unsafe');
    if (previous !== null && previous >= entry.path) throw new Error('P10-V manifest paths are not strictly sorted/unique');
    previous = entry.path;
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0 || entry.sizeBytes > MAX_FILE_BYTES) throw new Error(`P10-V manifest size is invalid: ${entry.path}`);
    if (!SHA256.test(entry.sha256 ?? '')) throw new Error(`P10-V manifest digest is invalid: ${entry.path}`);
    const absolute = resolve(root, entry.path);
    if (!pathIsWithinRoot(root, absolute) || !existsSync(absolute)) throw new Error(`P10-V finalized artifact is missing: ${entry.path}`);
    const info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`P10-V finalized artifact type changed: ${entry.path}`);
    const bytes = readFileSync(absolute);
    if (bytes.length !== entry.sizeBytes || sha256(bytes) !== entry.sha256) throw new Error(`P10-V finalized artifact bytes changed: ${entry.path}`);
    manifestPaths.push(entry.path);
  }

  const sumsExpected = manifest.files.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n';
  const sumsActual = readFileSync(resolve(root, 'SHA256SUMS'), 'utf8');
  if (sumsActual !== sumsExpected) throw new Error('P10-V SHA256SUMS does not exactly match finalized manifest');

  const allowedPostFinalize = new Set([...manifestPaths, 'manifest.json', 'SHA256SUMS', 'review/independent-review.json']);
  const actual = listEvidenceFiles(root).sort();
  for (const path of actual) if (!allowedPostFinalize.has(path)) throw new Error(`P10-V unmanifested artifact appeared after finalization: ${path}`);
  for (const path of allowedPostFinalize) if (!actual.includes(path)) throw new Error(`P10-V required finalized/review artifact is missing: ${path}`);
}

export function verifyP10vIndependentAcceptance({ evidenceDir, expectedSourceCommit }) {
  if (!/^[0-9a-f]{40}$/u.test(expectedSourceCommit ?? '')) throw new Error('expectedSourceCommit is invalid');
  const candidate = externalOutputPath(SOURCE_ROOT, evidenceDir, '--evidence-dir');
  if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isDirectory()) throw new Error('P10-V evidence directory must be a real existing directory');
  const root = realpathSync(candidate);
  if (pathIsWithinRoot(SOURCE_ROOT, root)) throw new Error('P10-V evidence directory must remain outside source');
  const manifestPath = resolve(root, 'manifest.json');
  const reviewPath = resolve(root, 'review/independent-review.json');
  const sumsPath = resolve(root, 'SHA256SUMS');
  if (!existsSync(manifestPath) || !existsSync(sumsPath) || !existsSync(reviewPath)) throw new Error('P10-V manifest, SHA256SUMS, and independent review receipt are required');
  if (lstatSync(manifestPath).isSymbolicLink() || lstatSync(sumsPath).isSymbolicLink() || lstatSync(reviewPath).isSymbolicLink()) throw new Error('P10-V acceptance inputs must not be symlinks');

  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  const manifest = readJson(manifestPath, 'manifest.json');
  if (manifest.status !== 'EVIDENCE_COMPLETE_REVIEW_PENDING') throw new Error('P10-V manifest is not at the review-pending boundary');
  if (manifest?.source?.commit !== expectedSourceCommit || manifest?.source?.clean !== true) throw new Error('P10-V manifest source identity mismatch');

  const review = readJson(reviewPath, 'review/independent-review.json');
  if (review.schemaVersion !== 1 || review.status !== 'PASS' || review.verdict !== 'ACCEPT') throw new Error('P10-V independent review is not accepted');
  if (review.reviewerIndependent !== true) throw new Error('P10-V review receipt does not assert independent reviewer separation');
  if (typeof review.reviewerId !== 'string' || review.reviewerId.trim().length < 2 || review.reviewerId.length > 256) throw new Error('P10-V review receipt reviewerId is invalid');
  if (!ISO_UTC.test(review.reviewedAt ?? '') || Number.isNaN(Date.parse(review.reviewedAt))) throw new Error('P10-V review receipt reviewedAt is invalid');
  if (review.sourceCommit !== expectedSourceCommit) throw new Error('P10-V review source commit mismatch');
  if (!SHA256.test(review.manifestSha256 ?? '') || review.manifestSha256 !== manifestSha256) throw new Error('P10-V review is not bound to the exact finalized manifest');
  if (!Array.isArray(review.findings) || review.findings.length !== 0) throw new Error('P10-V independent review still contains open findings');

  verifyFinalizedBytes(root, manifest);
  return { status: 'ACCEPTED', sourceCommit: expectedSourceCommit, manifestSha256, reviewerId: review.reviewerId, reviewedAt: review.reviewedAt };
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const evidenceDir = valueAfter('--evidence-dir');
  const expectedSourceCommit = valueAfter('--source-commit');
  if (!evidenceDir || !expectedSourceCommit) throw new Error('--evidence-dir and --source-commit are required');
  process.stdout.write(`${JSON.stringify(verifyP10vIndependentAcceptance({ evidenceDir, expectedSourceCommit }), null, 2)}\n`);
}
