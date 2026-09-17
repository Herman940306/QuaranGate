#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { externalOutputPath, pathIsWithinRoot } from '../../scripts/release-path-safety.mjs';
import {
  P10V_REQUIRED_DEMO_IDS,
  P10V_REQUIRED_EVIDENCE_FILES,
  P10V_REQUIRED_ROUTE_IDS,
  P10V_SCHEMA_VERSION,
} from '../contracts/p10v-visual-evidence.mjs';

const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const PNG_MAGIC = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const WEBM_EBML_MAGIC = Buffer.from([0x1a,0x45,0xdf,0xa3]);

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function readJson(path, label) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`${label} must be valid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}
function assertSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('expected source identity is required');
  for (const key of ['commit','tree']) if (!/^[0-9a-f]{40}$/u.test(source[key] ?? '')) throw new Error(`expected source ${key} is invalid`);
  if (source.clean !== true) throw new Error('expected source must be clean');
}
function assertPassJson(root, rel) {
  const value = readJson(resolve(root, rel), rel);
  if (value.status !== 'PASS') throw new Error(`${rel} is not PASS`);
  return value;
}
function sourceIdentityMatches(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return (actual.repository ?? null) === (expected.repository ?? null)
    && (actual.branch ?? null) === (expected.branch ?? null)
    && actual.commit === expected.commit
    && actual.tree === expected.tree
    && actual.clean === true;
}
function assertMediaMagic(path, expected, label) {
  const bytes = readFileSync(path);
  if (bytes.length <= expected.length || !bytes.subarray(0, expected.length).equals(expected)) throw new Error(`${label} has invalid media signature`);
}
function assertPlaywrightJsonReport(playwright) {
  if (!playwright || typeof playwright !== 'object' || Array.isArray(playwright)) throw new Error('P10-V Playwright report is invalid');
  const stats = playwright.stats;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) throw new Error('P10-V Playwright JSON report is missing stats');
  for (const key of ['expected','skipped','unexpected','flaky']) {
    if (!Number.isInteger(stats[key]) || stats[key] < 0) throw new Error(`P10-V Playwright stats.${key} is invalid`);
  }
  if (!Array.isArray(playwright.errors)) throw new Error('P10-V Playwright JSON report is missing errors');
  if (stats.unexpected !== 0 || stats.skipped !== 0 || stats.flaky !== 0 || playwright.errors.length !== 0) {
    throw new Error('P10-V Playwright result contains unexpected/skipped/flaky/error outcomes');
  }
  if (stats.expected < 1) throw new Error('P10-V Playwright report contains no expected passing tests');
  return playwright;
}
function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = resolve(dir, entry.name);
    const rel = relative(root, absolute).split(sep).join('/');
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`P10-V evidence contains a symlink: ${rel}`);
    if (entry.isDirectory()) { walk(root, absolute, out); continue; }
    if (!entry.isFile()) throw new Error(`P10-V evidence contains a non-regular artifact: ${rel}`);
    if (['manifest.json','SHA256SUMS'].includes(rel)) continue;
    if (info.size <= 0) throw new Error(`P10-V evidence artifact is empty: ${rel}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`P10-V evidence artifact exceeds per-file bound: ${rel}`);
    out.push({ rel, absolute, sizeBytes: info.size });
    if (out.length > MAX_FILES) throw new Error('P10-V evidence file-count bound exceeded');
  }
  return out;
}

export function finalizeP10vEvidence({ evidenceDir, expectedSource }) {
  assertSource(expectedSource);
  const candidate = externalOutputPath(SOURCE_ROOT, evidenceDir, '--evidence-dir');
  if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isDirectory()) throw new Error('P10-V evidence directory must be a real existing directory');
  const root = realpathSync(candidate);
  if (pathIsWithinRoot(SOURCE_ROOT, root)) throw new Error('P10-V evidence directory must remain outside source');
  if (process.platform !== 'win32' && (statSync(root).mode & 0o077) !== 0) throw new Error('P10-V evidence directory must be owner-only (0700)');
  if (existsSync(resolve(root, 'manifest.json')) || existsSync(resolve(root, 'SHA256SUMS'))) throw new Error('P10-V final evidence outputs already exist; refuse overwrite');

  if (existsSync(resolve(root, 'review/independent-review.json'))) throw new Error('P10-V independent review receipt must be created only after evidence finalization');

  for (const rel of ['README.md','contract.json','readiness.json', ...P10V_REQUIRED_EVIDENCE_FILES]) if (!existsSync(resolve(root, rel))) throw new Error(`P10-V required evidence missing: ${rel}`);
  for (const id of P10V_REQUIRED_ROUTE_IDS) if (!existsSync(resolve(root, 'screenshots/routes', `${id}.png`))) throw new Error(`P10-V route screenshot missing: ${id}`);
  for (const id of P10V_REQUIRED_DEMO_IDS) if (!existsSync(resolve(root, 'demos', `${id}.webm`))) throw new Error(`P10-V demo clip missing: ${id}`);

  const readiness = assertPassJson(root, 'readiness.json');
  if (!sourceIdentityMatches(readiness.source, expectedSource)) throw new Error('P10-V readiness source identity mismatch');
  const contract = readJson(resolve(root, 'contract.json'), 'contract.json');
  if (contract.schemaVersion !== P10V_SCHEMA_VERSION || contract.authority !== 'REAL_QUARANGATE_RUNTIME_ONLY' || contract.mockServerAcceptedAsAuthority !== false) throw new Error('P10-V contract authority is invalid');
  if (JSON.stringify(contract.routeIds) !== JSON.stringify(P10V_REQUIRED_ROUTE_IDS) || JSON.stringify(contract.demoIds) !== JSON.stringify(P10V_REQUIRED_DEMO_IDS)) throw new Error('P10-V contract route/demo set drifted');
  for (const id of P10V_REQUIRED_ROUTE_IDS) assertMediaMagic(resolve(root, 'screenshots/routes', `${id}.png`), PNG_MAGIC, `P10-V route screenshot ${id}`);
  for (const id of P10V_REQUIRED_DEMO_IDS) assertMediaMagic(resolve(root, 'demos', `${id}.webm`), WEBM_EBML_MAGIC, `P10-V demo ${id}`);

  const sourceReceipt = assertPassJson(root, 'identity/source.json');
  if (!sourceIdentityMatches(sourceReceipt.source, expectedSource)) throw new Error('P10-V source receipt does not match expected exact source identity');
  const runtime = assertPassJson(root, 'identity/runtime.json');
  if (runtime.sourceCommit !== expectedSource.commit || runtime.runtimeRevision !== expectedSource.commit) throw new Error('P10-V runtime is not bound to the exact accepted source commit');
  if (runtime.environment !== 'DISPOSABLE_QUALIFICATION' || runtime.productionData !== false || runtime.customerData !== false) {
    throw new Error('P10-V runtime is not attested as disposable qualification with no production/customer data');
  }
  assertPassJson(root, 'identity/browser.json');
  const playwright = assertPlaywrightJsonReport(readJson(resolve(root, 'playwright/results.json'), 'playwright/results.json'));
  const visual = assertPassJson(root, 'visual/summary.json');
  if (visual.sourceCommit !== expectedSource.commit || visual.mismatches !== 0 || visual.routesCompared !== P10V_REQUIRED_ROUTE_IDS.length) {
    throw new Error('P10-V visual comparison receipt is incomplete, stale, or contains mismatches');
  }
  if (!['INITIAL_CANONICAL_BASELINE_REVIEW_REQUIRED','EXACT_ACCEPTED_BASELINE_COMPARISON'].includes(visual.mode)) throw new Error('P10-V visual comparison mode is invalid');
  if (!/^[0-9a-f]{40}$/u.test(visual.baselineSourceCommit ?? '')) throw new Error('P10-V visual baseline source commit is invalid');
  if (visual.mode === 'INITIAL_CANONICAL_BASELINE_REVIEW_REQUIRED' && visual.baselineSourceCommit !== expectedSource.commit) throw new Error('P10-V initial visual baseline is not bound to current source');
  const accessibility = assertPassJson(root, 'accessibility/report.json');
  if (accessibility.serious !== 0 || accessibility.critical !== 0) throw new Error('P10-V accessibility report contains serious/critical violations');
  const consoleSummary = assertPassJson(root, 'observability/console-summary.json');
  if (!Array.isArray(consoleSummary.errors) || consoleSummary.errors.length !== 0 || consoleSummary.pageErrorCount !== 0 || consoleSummary.consoleErrorCount !== 0) throw new Error('P10-V console summary contains errors');
  const networkSummary = assertPassJson(root, 'observability/network-summary.json');
  if (networkSummary.secretsIncluded !== false) throw new Error('P10-V safe network summary is not secret-free');
  const security = assertPassJson(root, 'security/public-media-scan.json');
  if (security.manualReview !== true || security.secrets !== 0 || security.pii !== 0 || security.privatePaths !== 0) {
    throw new Error('P10-V public media has not passed manual + secret/PII/private-path review');
  }

  const files = walk(root).sort((a,b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) throw new Error('P10-V evidence total-byte bound exceeded');
  const entries = files.map((file) => {
    const bytes = readFileSync(file.absolute);
    return { path: file.rel, sizeBytes: file.sizeBytes, sha256: sha256(bytes) };
  });
  if (entries.some((entry) => !SHA256.test(entry.sha256))) throw new Error('P10-V evidence hash generation failed');

  const manifest = {
    schemaVersion: P10V_SCHEMA_VERSION,
    status: 'EVIDENCE_COMPLETE_REVIEW_PENDING',
    source: expectedSource,
    routeIds: [...P10V_REQUIRED_ROUTE_IDS],
    demoIds: [...P10V_REQUIRED_DEMO_IDS],
    fileCount: entries.length,
    totalBytes,
    files: entries,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const sums = entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n';
  writeFileSync(resolve(root, 'manifest.json'), manifestBytes, { mode: 0o600, flag: 'wx' });
  writeFileSync(resolve(root, 'SHA256SUMS'), sums, { mode: 0o600, flag: 'wx' });
  return { status: 'EVIDENCE_COMPLETE_REVIEW_PENDING', files: entries.length, totalBytes, manifestSha256: sha256(manifestBytes) };
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--evidence-dir');
  const evidenceDir = at >= 0 ? args[at + 1] : undefined;
  if (!evidenceDir) throw new Error('--evidence-dir is required');
  const { verifyCurrentSourceIdentity } = await import('../contracts/current-source.mjs');
  const current = verifyCurrentSourceIdentity();
  const expectedSource = { repository: current.repository ?? null, branch: current.branch, commit: current.head, tree: current.tree, clean: true };
  process.stdout.write(`${JSON.stringify(finalizeP10vEvidence({ evidenceDir, expectedSource }), null, 2)}\n`);
}
