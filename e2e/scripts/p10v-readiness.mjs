#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { externalPrivateEvidenceDirectory } from '../../scripts/release-path-safety.mjs';
import { verifyCurrentSourceIdentity } from '../contracts/current-source.mjs';
import { p10vContract, validateP10vRuntimeUrl } from '../contracts/p10v-visual-evidence.mjs';

const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const baseURL = validateP10vRuntimeUrl(valueAfter('--base-url') ?? process.env.QG_P10V_BASE_URL ?? '');
const evidenceRaw = valueAfter('--evidence-dir') ?? process.env.QG_P10V_EVIDENCE_DIR;
const p10SummaryPath = valueAfter('--p10-summary') ?? process.env.QG_P10V_P10_SUMMARY;
if (!evidenceRaw) throw new Error('--evidence-dir is required');
if (!p10SummaryPath || !existsSync(resolve(p10SummaryPath))) throw new Error('--p10-summary must reference an existing P10 release-assurance summary.json');

const source = verifyCurrentSourceIdentity();
const p10 = JSON.parse(readFileSync(resolve(p10SummaryPath), 'utf8'));
const p10Matches = p10?.source?.commit === source.head && p10?.source?.tree === source.tree && p10?.source?.clean === true;
if (p10?.status !== 'PASS' || !p10Matches) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: 'BLOCKED_ENVIRONMENT',
    failureCode: p10Matches ? 'P10_NOT_ACCEPTED' : 'P10_SOURCE_BINDING_MISMATCH',
    source,
    p10Status: p10?.status ?? null,
  }, null, 2)}\n`);
  process.exit(4);
}

const evidenceDir = externalPrivateEvidenceDirectory(SOURCE_ROOT, evidenceRaw, '--evidence-dir');
for (const dir of ['identity','screenshots/routes','demos','playwright','visual','accessibility','observability','security','review']) {
  mkdirSync(resolve(evidenceDir, dir), { recursive: true, mode: 0o700 });
}
const sourceReceipt = { schemaVersion: 1, status: 'PASS', source: { repository: source.repository ?? null, branch: source.branch, commit: source.head, tree: source.tree, clean: true } };
writeFileSync(resolve(evidenceDir, 'identity/source.json'), `${JSON.stringify(sourceReceipt, null, 2)}\n`, { mode: 0o600 });
writeFileSync(resolve(evidenceDir, 'contract.json'), `${JSON.stringify(p10vContract(), null, 2)}\n`, { mode: 0o600 });
writeFileSync(resolve(evidenceDir, 'README.md'), `# QuaranGate P10-V evidence\n\nSource: ${source.head}\nTree: ${source.tree}\nRuntime target: ${baseURL}\n\nThis directory is qualification evidence, not public media. Final P10-V acceptance requires evidence finalization plus an independent review receipt bound to the finalized manifest.\n`, { mode: 0o600 });

const dependencyPath = resolve(SOURCE_ROOT, 'e2e/node_modules/@playwright/test/package.json');
let browser = null;
let missing = null;
if (!existsSync(dependencyPath)) {
  missing = 'E2E_DEPENDENCIES_UNAVAILABLE';
} else {
  const probe = spawnSync(process.execPath, [resolve(SOURCE_ROOT, 'e2e/scripts/browser-readiness.mjs')], { encoding: 'utf8' });
  try { browser = JSON.parse((probe.stdout || '').trim()); } catch { browser = null; }
  if (probe.status !== 0 || browser?.ok !== true) missing = browser?.code ?? 'BROWSER_RUNTIME_UNAVAILABLE';
}

if (!missing) {
  try {
    const response = await fetch(baseURL, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (!response.ok) missing = 'REAL_RUNTIME_UNAVAILABLE';
  } catch { missing = 'REAL_RUNTIME_UNAVAILABLE'; }
}

const readiness = {
  schemaVersion: 1,
  status: missing ? 'BLOCKED_ENVIRONMENT' : 'PASS',
  source: sourceReceipt.source,
  p10: { status: p10.status, summary: resolve(p10SummaryPath) },
  baseURL,
  browser: browser?.ok === true ? { name: browser.browser, version: browser.version } : null,
  ...(missing ? { failureCode: missing } : {}),
};
writeFileSync(resolve(evidenceDir, 'readiness.json'), `${JSON.stringify(readiness, null, 2)}\n`, { mode: 0o600 });
if (missing) {
  process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
  process.exit(4);
}
writeFileSync(resolve(evidenceDir, 'identity/browser.json'), `${JSON.stringify({ schemaVersion: 1, status: 'PASS', browser: browser.browser, version: browser.version }, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
