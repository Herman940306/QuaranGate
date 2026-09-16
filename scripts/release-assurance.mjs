#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflinePrerequisites } from './release-scanner-run.mjs';
import { externalPrivateEvidenceDirectory } from './release-path-safety.mjs';

const SOURCE_ROOT = realpathSync(resolve(fileURLToPath(new URL('../', import.meta.url))));
const INTRINSIC_GATES = ['typecheck', 'build', 'unit', 'integration', 'e2e', 'authority-invariants', 'security-fuzz', 'sbom'];
const SCANNER_GATES = ['sast', 'secrets', 'sca', 'config-scan', 'image-scan'];
const TOOL_IDS = { sast: 'semgrep', secrets: 'gitleaks', sca: 'osv-scanner', 'config-scan': 'trivy', 'image-scan': 'trivy' };
const EXIT = { PASS: 0, BLOCKED_ENVIRONMENT: 4, FAIL: 5 };

export function resolveAssuranceInputs(argv = [], env = process.env) {
  const valueAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const from = (flag, envKey) => { const cli = valueAfter(flag); if (typeof cli === 'string' && cli.trim()) return cli; const value = env[envKey]; return typeof value === 'string' && value.trim() ? value : undefined; };
  return {
    evidenceDirRaw: from('--evidence-dir', 'QG_RELEASE_EVIDENCE_DIR'),
    imageInputs: from('--image-inputs', 'QG_RELEASE_IMAGE_INPUTS'),
    releaseManifest: from('--release-manifest', 'QG_RELEASE_MANIFEST'),
    sigstoreBundle: from('--sigstore-bundle', 'QG_RELEASE_SIGSTORE_BUNDLE'),
    publicKey: from('--public-key', 'QG_RELEASE_PUBLIC_KEY'),
  };
}

export function dockerRuntimePrerequisites(probe = () => spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })) {
  const result = probe();
  if (result?.error?.code === 'ENOENT') return ['DOCKER_CLI_UNAVAILABLE'];
  if (result?.error || result?.status !== 0) return ['DOCKER_RUNTIME_UNAVAILABLE'];
  return [];
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} is malformed JSON`); }
}
function externalDir(path) { return externalPrivateEvidenceDirectory(SOURCE_ROOT, path, '--evidence-dir'); }

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { cwd: SOURCE_ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
}
function runScript(script, args, options = {}) { return runNode([script, ...args], options); }
function assertExpectedExit(result, allowed, label) {
  if (result.error) throw new Error(`${label} execution failed: ${result.error.code ?? result.error.message}`);
  if (!allowed.includes(result.status)) throw new Error(`${label} returned unexpected exit ${result.status}: ${(result.stderr ?? '').slice(0, 500)}`);
}
function writeUnavailable(path, { gate, source, tool, failureCode, missingPrerequisites = [] }) {
  const receipt = { schemaVersion: 1, gate, status: 'UNAVAILABLE', source, tool, failureCode, missingPrerequisites: [...new Set(missingPrerequisites)].sort() };
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}
function exactTool(toolchain, id) { return Array.isArray(toolchain?.tools) ? toolchain.tools.find((x) => x?.id === id) : null; }

export function classifyAssurance(policyReport, receipts) {
  if (policyReport?.verdict === 'PASS' && policyReport?.ok === true) return 'PASS';
  const unavailable = new Set(Object.entries(receipts).filter(([, receipt]) => receipt?.status === 'UNAVAILABLE').map(([gate]) => gate));
  const failed = Object.values(receipts).some((receipt) => receipt?.status === 'FAIL');
  if (failed) return 'FAIL';
  const failures = Array.isArray(policyReport?.failures) ? policyReport.failures : [];
  if (unavailable.size > 0 && failures.length > 0 && failures.every((failure) => failure?.code === 'GATE_NOT_PASS' && unavailable.has(failure?.gate))) return 'BLOCKED_ENVIRONMENT';
  return 'FAIL';
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { evidenceDirRaw, imageInputs, releaseManifest, sigstoreBundle, publicKey } = resolveAssuranceInputs(argv, env);
  if (!evidenceDirRaw) throw new Error('--evidence-dir is required');
  const evidenceDir = externalDir(evidenceDirRaw); const receiptsDir = join(evidenceDir, 'receipts'); const rawDir = join(evidenceDir, 'raw');
  mkdirSync(receiptsDir, { recursive: true, mode: 0o700 }); mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  const sourceBindingPath = join(evidenceDir, 'source-binding.json');
  const toolchainPath = join(evidenceDir, 'toolchain.json');
  const policyReportPath = join(evidenceDir, 'policy.json');
  const summaryPath = join(evidenceDir, 'summary.json');
  const sbomPath = join(evidenceDir, 'sbom.spdx.json');

  let result = runScript('scripts/release-source-binding.mjs', ['--repository', SOURCE_ROOT, '--output', sourceBindingPath]);
  assertExpectedExit(result, [0], 'source binding');
  const sourceBinding = readJson(sourceBindingPath, 'source-binding receipt'); const source = sourceBinding.source;

  result = runScript('scripts/security-toolchain.mjs', ['--report-only', '--output', toolchainPath]);
  assertExpectedExit(result, [0], 'toolchain report-only');
  const toolchain = readJson(toolchainPath, 'toolchain report');
  const policy = readJson(join(SOURCE_ROOT, 'security/release-policy.json'), 'release policy');
  const receipts = {};

  for (const gate of INTRINSIC_GATES) {
    const receiptPath = join(receiptsDir, `${gate}.json`);
    const args = ['--gate', gate, '--source-binding', sourceBindingPath, '--output', receiptPath];
    if (gate === 'sbom') args.push('--artifact-output', sbomPath);
    result = runScript('scripts/release-gate-receipt.mjs', args);
    assertExpectedExit(result, [0, 4, 5], `${gate} gate`);
    receipts[gate] = readJson(receiptPath, `${gate} receipt`);
  }

  for (const gate of SCANNER_GATES) {
    const receiptPath = join(receiptsDir, `${gate}.json`); const expectedTool = policy.expectedTools[gate]; const tool = exactTool(toolchain, TOOL_IDS[gate]);
    const unavailable = [];
    if (!tool || tool.status !== 'PASS') unavailable.push(`${TOOL_IDS[gate].toUpperCase().replaceAll('-', '_')}_${tool?.status ?? 'UNAVAILABLE'}`);
    unavailable.push(...validateOfflinePrerequisites(gate, env));
    if (gate === 'image-scan') {
      if (!imageInputs || !existsSync(imageInputs)) unavailable.push('RELEASE_IMAGE_INPUTS_UNAVAILABLE');
      else unavailable.push(...dockerRuntimePrerequisites());
    }
    if (unavailable.length) {
      receipts[gate] = writeUnavailable(receiptPath, { gate, source, tool: expectedTool, failureCode: 'SCANNER_PREREQUISITES_UNAVAILABLE', missingPrerequisites: unavailable });
      continue;
    }
    const rawPath = join(rawDir, `${gate}.json`); const imageIdentityPath = join(rawDir, 'image-identities.json');
    const scannerArgs = ['--gate', gate, '--output', rawPath, '--source-binding', sourceBindingPath, '--toolchain-report', toolchainPath];
    if (gate === 'image-scan') scannerArgs.push('--image-inputs', imageInputs, '--image-identities-output', imageIdentityPath);
    result = runScript('scripts/release-scanner-run.mjs', scannerArgs, { env });
    assertExpectedExit(result, [0, 1], `${gate} scanner`);
    const scanArgs = ['--gate', gate, '--input', rawPath, '--source-binding', sourceBindingPath, '--toolchain-report', toolchainPath, '--scanner-exit-code', String(result.status), '--output', receiptPath];
    if (gate === 'image-scan') scanArgs.push('--image-identities', imageIdentityPath);
    const normalized = runScript('scripts/release-scan-receipt.mjs', scanArgs);
    assertExpectedExit(normalized, [0, 4], `${gate} normalization`);
    receipts[gate] = readJson(receiptPath, `${gate} receipt`);
  }

  const provenancePath = join(receiptsDir, 'provenance.json');
  const provenanceTool = policy.expectedTools.provenance;
  if (!releaseManifest || !existsSync(releaseManifest) || !sigstoreBundle || !existsSync(sigstoreBundle) || !publicKey || !existsSync(publicKey)) {
    const missing = [];
    if (!releaseManifest || !existsSync(releaseManifest)) missing.push('RELEASE_MANIFEST_UNAVAILABLE');
    if (!sigstoreBundle || !existsSync(sigstoreBundle)) missing.push('SIGSTORE_BUNDLE_UNAVAILABLE');
    if (!publicKey || !existsSync(publicKey)) missing.push('PUBLIC_KEY_UNAVAILABLE');
    receipts.provenance = writeUnavailable(provenancePath, { gate: 'provenance', source, tool: provenanceTool, failureCode: 'PROVENANCE_INPUTS_UNAVAILABLE', missingPrerequisites: missing });
  } else {
    const statement = join(evidenceDir, 'provenance.intoto.json');
    result = runScript('scripts/release-provenance.mjs', ['--source-binding', sourceBindingPath, '--release-manifest', releaseManifest, '--sbom', sbomPath, '--statement-output', statement, '--bundle', sigstoreBundle, '--public-key', publicKey, '--output', provenancePath]);
    assertExpectedExit(result, [0, 4, 5], 'provenance gate');
    receipts.provenance = readJson(provenancePath, 'provenance receipt');
  }

  result = runScript('scripts/release-security-policy.mjs', ['--evidence-dir', receiptsDir, '--source-binding', sourceBindingPath, '--output', policyReportPath]);
  assertExpectedExit(result, [0, 3], 'release security policy');
  const policyReport = readJson(policyReportPath, 'policy report');
  const status = classifyAssurance(policyReport, receipts);
  let evidenceBundle = null;
  if (status === 'PASS') {
    const bundlePath = join(evidenceDir, 'release-evidence-bundle.json');
    result = runScript('scripts/release-evidence-bundle.mjs', [
      '--evidence-dir', receiptsDir, '--source-binding', sourceBindingPath, '--release-manifest', releaseManifest,
      '--sbom', sbomPath, '--policy-report', policyReportPath, '--output', bundlePath,
    ]);
    assertExpectedExit(result, [0], 'release evidence bundle');
    const bytes = readFileSync(bundlePath);
    evidenceBundle = { path: bundlePath, sha256: sha256(bytes), bytes: bytes.length };
  }
  const summary = {
    schemaVersion: 1,
    status,
    source,
    acquisitionPolicy: toolchain.acquisitionPolicy,
    toolchainOk: toolchain.ok === true,
    gates: Object.fromEntries(policy.requiredGates.map((gate) => [gate, receipts[gate]?.status ?? 'MISSING'])),
    unavailable: policy.requiredGates.filter((gate) => receipts[gate]?.status === 'UNAVAILABLE').map((gate) => ({ gate, failureCode: receipts[gate].failureCode, missingPrerequisites: receipts[gate].missingPrerequisites ?? [] })),
    policy: { verdict: policyReport.verdict, failureCount: Array.isArray(policyReport.failures) ? policyReport.failures.length : null },
    ...(evidenceBundle ? { evidenceBundle } : {}),
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return EXIT[status];
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`RELEASE_ASSURANCE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = EXIT.FAIL; }
}
