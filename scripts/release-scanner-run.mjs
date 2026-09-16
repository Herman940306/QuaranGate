#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { externalOutputPath } from './release-path-safety.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const GATES = new Set(['sast', 'secrets', 'sca', 'config-scan', 'image-scan']);
const TOOL_FOR_GATE = { sast: 'semgrep', secrets: 'gitleaks', sca: 'osv-scanner', 'config-scan': 'trivy', 'image-scan': 'trivy' };

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} is malformed JSON`); }
}
function sourceRoot() { return realpathSync(resolve(fileURLToPath(new URL('../', import.meta.url)))); }
function outputOutsideSource(path, label) { return externalOutputPath(sourceRoot(), path, label); }

function sameSource(a, b) {
  return a?.clean === true && b?.clean === true && a.commit === b.commit && a.tree === b.tree && a.repository === b.repository;
}
function currentSource() {
  const run = (args) => spawnSync('git', ['-C', sourceRoot(), ...args], { encoding: 'utf8' });
  const head = run(['rev-parse', 'HEAD']); const tree = run(['rev-parse', 'HEAD^{tree}']); const status = run(['status', '--porcelain=v1', '--untracked-files=all']); const origin = run(['config', '--get', 'remote.origin.url']);
  if ([head, tree, status, origin].some((r) => r.error || r.status !== 0) || status.stdout.trim()) throw new Error('scanner source is not an exact clean Git worktree');
  return { repository: origin.stdout.trim(), commit: head.stdout.trim(), tree: tree.stdout.trim(), clean: true };
}
function validateSourceBinding(path) {
  const r = readJson(path, 'source-binding receipt'); const s = r?.source;
  if (r?.schemaVersion !== 1 || r?.gate !== 'source-binding' || r?.status !== 'PASS' || s?.clean !== true || !/^[0-9a-f]{40}$/u.test(s?.commit ?? '') || !/^[0-9a-f]{40}$/u.test(s?.tree ?? '')) throw new Error('source-binding receipt is invalid');
  return s;
}
function validateToolchain(path, gate) {
  const r = readJson(path, 'toolchain report');
  const id = TOOL_FOR_GATE[gate]; const t = Array.isArray(r?.tools) ? r.tools.find((x) => x?.id === id) : null;
  if (r?.schemaVersion !== 1 || r?.acquisitionPolicy !== 'NO_AUTO_DOWNLOAD_OWNER_PROVIDED_VERIFIED_ARTIFACTS_ONLY' || !t || t.status !== 'PASS') throw new Error(`toolchain does not prove required scanner: ${id}`);
  return t;
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function run(binary, args, options = {}) {
  return spawnSync(binary, args, { cwd: sourceRoot(), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
}
function assertResult(result, label) {
  if (result.error) throw new Error(`${label} execution failed: ${result.error.code ?? result.error.message}`);
  if (![0, 1].includes(result.status)) throw new Error(`${label} scanner error exit ${result.status}`);
}
function validateImageInputs(path) {
  const input = readJson(path, 'image inputs');
  if (input?.schemaVersion !== 1 || !Array.isArray(input.images) || input.images.length === 0) throw new Error('image inputs are invalid');
  const images = input.images.map((x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).sort().join(',') !== 'component,digest,reference') throw new Error('image input has unknown or missing fields');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(x.component ?? '') || typeof x.reference !== 'string' || !x.reference || /\s|@|(?:^|:)latest$/iu.test(x.reference) || !IMAGE_DIGEST.test(x.digest ?? '')) throw new Error('image input identity is invalid or mutable');
    return { component: x.component, reference: x.reference, digest: x.digest };
  });
  const keys = images.map((x) => x.component);
  if (keys.some((x, i) => i > 0 && keys[i - 1] >= x)) throw new Error('image inputs must be sorted and unique by component');
  return images;
}
export function validateOfflinePrerequisites(gate, env = process.env) {
  if (gate === 'sca') {
    const root = env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY;
    if (!root || !existsSync(root) || !statSync(root).isDirectory() || !existsSync(resolve(root, 'osv-scanner', 'npm', 'all.zip'))) return ['OSV_OFFLINE_DATABASE_UNAVAILABLE'];
  }
  if (gate === 'config-scan' || gate === 'image-scan') {
    const root = env.QG_TRIVY_CACHE_DIR;
    if (!root || !existsSync(root) || !statSync(root).isDirectory()) return ['TRIVY_OFFLINE_CACHE_UNAVAILABLE'];
  }
  return [];
}

export function scannerPlan(gate, { output = '/evidence/raw.json', imageInputs = null, env = process.env } = {}) {
  if (!GATES.has(gate)) throw new Error('unsupported release scanner gate');
  if (gate === 'sast') return { binary: 'semgrep', args: ['scan', '--config', 'security/semgrep.yml', '--json', '--error', '--metrics=off', '--disable-version-check', '--jobs', '1', '.'], outputMode: 'stdout-json', env: {} };
  if (gate === 'secrets') return { binary: 'gitleaks', args: ['dir', '--no-banner', '--no-color', '--redact=100', '--report-format', 'json', '--report-path', output, '.'], outputMode: 'scanner-file', env: {} };
  if (gate === 'sca') return { binary: 'osv-scanner', args: ['scan', 'source', '--recursive', '--offline', '--offline-vulnerabilities', '--format', 'json', '.'], outputMode: 'stdout-json', env: { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY } };
  if (gate === 'config-scan') return { binary: 'trivy', args: ['--cache-dir', env.QG_TRIVY_CACHE_DIR, 'config', '--skip-check-update', '--skip-version-check', '--format', 'json', '--exit-code', '1', '--output', output, '.'], outputMode: 'scanner-file', env: {} };
  if (!imageInputs?.length) throw new Error('image-scan requires exact immutable image inputs');
  return { binary: 'trivy', batch: imageInputs.map((image) => ({ image, args: ['--cache-dir', env.QG_TRIVY_CACHE_DIR, 'image', '--image-src', 'docker', '--offline-scan', '--skip-db-update', '--skip-java-db-update', '--skip-check-update', '--skip-version-check', '--skip-vex-repo-update', '--scanners', 'vuln,secret', '--image-config-scanners', 'misconfig,secret', '--format', 'json', '--exit-code', '1', `${image.reference}@${image.digest}`] })), outputMode: 'batch-stdout-json', env: {} };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const valueAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const gate = valueAfter('--gate'); const outputRaw = valueAfter('--output'); const sourceBindingPath = valueAfter('--source-binding'); const toolchainPath = valueAfter('--toolchain-report'); const imageInputPath = valueAfter('--image-inputs'); const identityOutputRaw = valueAfter('--image-identities-output');
  if (!GATES.has(gate)) throw new Error('--gate must be one of sast,secrets,sca,config-scan,image-scan');
  if (!outputRaw) throw new Error('--output is required');
  if (!sourceBindingPath || !existsSync(sourceBindingPath)) throw new Error('--source-binding requires an existing receipt');
  if (!toolchainPath || !existsSync(toolchainPath)) throw new Error('--toolchain-report requires an existing report');
  const output = outputOutsideSource(outputRaw, '--output');
  const source = validateSourceBinding(sourceBindingPath); if (!sameSource(source, currentSource())) throw new Error('source-binding receipt does not match current source');
  validateToolchain(toolchainPath, gate);
  const missing = validateOfflinePrerequisites(gate, env); if (missing.length) { const error = new Error(missing.join(',')); error.code = 'OFFLINE_PREREQUISITE_UNAVAILABLE'; throw error; }
  const images = gate === 'image-scan' ? validateImageInputs(imageInputPath) : null;
  if (gate === 'image-scan' && !identityOutputRaw) throw new Error('--image-identities-output is required for image-scan');
  const plan = scannerPlan(gate, { output, imageInputs: images, env });
  let exitCode = 0;
  if (plan.outputMode === 'batch-stdout-json') {
    const reports = [];
    for (const item of plan.batch) {
      const result = run(plan.binary, item.args, { env: { ...process.env, ...plan.env } }); assertResult(result, gate); exitCode = Math.max(exitCode, result.status); let parsed;
      try { parsed = JSON.parse(result.stdout); } catch { throw new Error('image scanner emitted malformed JSON'); }
      reports.push(parsed);
    }
    writeFileSync(output, `${JSON.stringify(reports, null, 2)}\n`, { mode: 0o600 });
    const identityOutput = outputOutsideSource(identityOutputRaw, '--image-identities-output');
    writeFileSync(identityOutput, `${JSON.stringify({ schemaVersion: 1, images }, null, 2)}\n`, { mode: 0o600 });
  } else {
    const result = run(plan.binary, plan.args, { env: { ...process.env, ...plan.env } }); assertResult(result, gate); exitCode = result.status;
    if (plan.outputMode === 'stdout-json') writeFileSync(output, result.stdout, { mode: 0o600 });
    if (!existsSync(output)) throw new Error(`${gate} scanner did not produce its JSON report`);
    try { JSON.parse(readFileSync(output, 'utf8')); } catch { throw new Error(`${gate} scanner report is malformed JSON`); }
  }
  if (!sameSource(source, currentSource())) throw new Error('scanner execution mutated or drifted source');
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, gate, scannerExitCode: exitCode, rawReport: { sha256: sha256(readFileSync(output)), bytes: statSync(output).size }, source }, null, 2)}\n`);
  return exitCode;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`${error?.code ?? 'SCANNER_RUN_FAILED'}: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = error?.code === 'OFFLINE_PREREQUISITE_UNAVAILABLE' ? 4 : 5; }
}
