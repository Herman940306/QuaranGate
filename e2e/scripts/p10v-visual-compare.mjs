#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { externalOutputPath, pathIsWithinRoot } from '../../scripts/release-path-safety.mjs';
import { P10V_REQUIRED_ROUTE_IDS } from '../contracts/p10v-visual-evidence.mjs';

const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COMMIT = /^[0-9a-f]{40}$/u;
const PNG_MAGIC = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function realExternalDirectory(candidate, label) {
  const absolute = externalOutputPath(SOURCE_ROOT, candidate, label);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isDirectory()) throw new Error(`${label} must be an existing real directory`);
  const real = realpathSync(absolute);
  if (pathIsWithinRoot(SOURCE_ROOT, real)) throw new Error(`${label} must remain outside source`);
  return real;
}

function screenshot(root, routeId) {
  const path = resolve(root, 'screenshots/routes', `${routeId}.png`);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error(`visual screenshot missing/unsafe: ${routeId}`);
  const bytes = readFileSync(path);
  if (bytes.length <= PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error(`visual screenshot is not PNG: ${routeId}`);
  return { routeId, sizeBytes: bytes.length, sha256: sha256(bytes) };
}

export function generateP10vVisualSummary({ evidenceDir, sourceCommit, mode, baselineDir, baselineSourceCommit }) {
  if (!COMMIT.test(sourceCommit ?? '')) throw new Error('sourceCommit is invalid');
  if (!['initial','compare'].includes(mode)) throw new Error('mode must be initial or compare');
  const evidence = realExternalDirectory(evidenceDir, '--evidence-dir');
  const current = P10V_REQUIRED_ROUTE_IDS.map((id) => screenshot(evidence, id));
  let baseline = null;
  let effectiveBaselineCommit = sourceCommit;
  const mismatches = [];

  if (mode === 'compare') {
    if (!baselineDir || !COMMIT.test(baselineSourceCommit ?? '')) throw new Error('compare mode requires --baseline-dir and --baseline-source-commit');
    baseline = realExternalDirectory(baselineDir, '--baseline-dir');
    if (baseline === evidence) throw new Error('baseline directory must differ from current evidence directory');
    effectiveBaselineCommit = baselineSourceCommit;
    for (const item of current) {
      const prior = screenshot(baseline, item.routeId);
      if (prior.sha256 !== item.sha256) mismatches.push({ routeId: item.routeId, baselineSha256: prior.sha256, currentSha256: item.sha256 });
    }
  }

  const summary = {
    schemaVersion: 1,
    status: mismatches.length === 0 ? 'PASS' : 'FAIL',
    mode: mode === 'initial' ? 'INITIAL_CANONICAL_BASELINE_REVIEW_REQUIRED' : 'EXACT_ACCEPTED_BASELINE_COMPARISON',
    sourceCommit,
    baselineSourceCommit: effectiveBaselineCommit,
    routesCompared: current.length,
    mismatches: mismatches.length,
    screenshots: current,
    mismatchDetails: mismatches,
  };
  const output = resolve(evidence, 'visual/summary.json');
  if (!pathIsWithinRoot(evidence, output)) throw new Error('visual summary output escaped evidence directory');
  if (existsSync(output)) throw new Error('visual/summary.json already exists; refuse overwrite');
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return summary;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const evidenceDir = valueAfter('--evidence-dir');
  const sourceCommit = valueAfter('--source-commit');
  const mode = valueAfter('--mode') ?? 'compare';
  const baselineDir = valueAfter('--baseline-dir');
  const baselineSourceCommit = valueAfter('--baseline-source-commit');
  if (!evidenceDir || !sourceCommit) throw new Error('--evidence-dir and --source-commit are required');
  const result = generateP10vVisualSummary({ evidenceDir, sourceCommit, mode, baselineDir, baselineSourceCommit });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'PASS') process.exitCode = 2;
}
