#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalOutputPath } from './release-path-safety.mjs';

const args = process.argv.slice(2);
const valueAfter = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const evidenceDir = valueAfter('--evidence-dir');
const sourceBindingPath = valueAfter('--source-binding');
const output = valueAfter('--output');
const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const policyPath = valueAfter('--policy') ?? 'security/release-policy.json';
const baselinePath = valueAfter('--baseline') ?? 'security/release-baseline.json';
const exceptionsPath = valueAfter('--exceptions') ?? 'security/release-exceptions.json';
const atRaw = valueAfter('--at') ?? new Date().toISOString();
if (!evidenceDir) throw new Error('--evidence-dir is required');
if (output) externalOutputPath(SOURCE_ROOT, output, '--output');
if (!sourceBindingPath || !existsSync(sourceBindingPath)) throw new Error('--source-binding requires an existing source-binding receipt');
const evaluatedAt = new Date(atRaw);
if (!Number.isFinite(evaluatedAt.getTime())) throw new Error('--at must be a valid ISO timestamp');

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} is malformed JSON`); }
}
function validSource(source) {
  return source?.clean === true && /^[0-9a-f]{40}$/u.test(source?.commit ?? '') && /^[0-9a-f]{40}$/u.test(source?.tree ?? '');
}
function sameSource(a, b) {
  return a?.clean === true && b?.clean === true && a?.commit === b?.commit && a?.tree === b?.tree && a?.repository === b?.repository;
}

const sourceBinding = readJson(sourceBindingPath, 'source-binding receipt');
if (sourceBinding.schemaVersion !== 1 || sourceBinding.gate !== 'source-binding' || sourceBinding.status !== 'PASS' || !validSource(sourceBinding.source)) {
  throw new Error('source-binding receipt is not a valid exact clean source receipt');
}
const source = sourceBinding.source;
const policy = readJson(policyPath, 'release policy');
const baseline = readJson(baselinePath, 'release baseline');
const exceptions = readJson(exceptionsPath, 'release exceptions');
const baselineEntries = Array.isArray(baseline.findings) ? baseline.findings : [];
const exceptionEntries = Array.isArray(exceptions.exceptions) ? exceptions.exceptions : [];
const receipts = [];
const failures = [];
const tolerated = [];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SHA256 = /^[0-9a-f]{64}$/u;
const executionCommandIds = {
  typecheck: 'typescript-typecheck',
  build: 'typescript-build',
  unit: 'vitest-unit',
  integration: 'vitest-integration',
  e2e: 'playwright-e2e',
  'authority-invariants': 'authority-invariants',
  'security-fuzz': 'security-fuzz',
  'security-chaos': 'vitest-security-chaos',
  sbom: 'release-sbom',
  provenance: 'cosign-verify-blob-attestation',
};
function validDigestEvidence(value) {
  return value && SHA256.test(value.sha256 ?? '') && Number.isInteger(value.bytes) && value.bytes >= 0;
}
function validExecution(value, expectedCommandId) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.commandId === 'string' && value.commandId.length > 0
    && (!expectedCommandId || value.commandId === expectedCommandId)
    && value.exitCode === 0 && value.signal === null
    && Number.isInteger(value.durationMs) && value.durationMs >= 0
    && validDigestEvidence(value.stdout) && validDigestEvidence(value.stderr);
}
function validateReceiptEvidence(gate, receipt, sourceBindingSha256) {
  const errors = [];
  const executionGate = ['typecheck', 'build', 'unit', 'integration', 'e2e', 'authority-invariants', 'security-fuzz', 'security-chaos', 'sbom', 'provenance'].includes(gate);
  if (executionGate && !validExecution(receipt.execution, executionCommandIds[gate])) errors.push('INVALID_EXECUTION_EVIDENCE');
  if (['unit', 'integration', 'e2e', 'security-chaos'].includes(gate)) {
    const counts = receipt.testCounts;
    if (!counts || !Number.isInteger(counts.files) || counts.files <= 0 || !Number.isInteger(counts.tests) || counts.tests <= 0 || counts.failed !== 0) errors.push('INVALID_TEST_COUNTS');
  }
  if (gate === 'authority-invariants') {
    const artifact = receipt.artifact;
    if (!artifact || !Number.isInteger(artifact.rulesChecked) || artifact.rulesChecked <= 0
      || !Number.isInteger(artifact.composeFilesChecked) || artifact.composeFilesChecked <= 0
      || !Number.isInteger(artifact.dockerfilesChecked) || artifact.dockerfilesChecked <= 0) errors.push('INVALID_AUTHORITY_EVIDENCE');
  }
  if (gate === 'security-fuzz') {
    const artifact = receipt.artifact;
    if (!artifact || !Number.isInteger(artifact.targetCount) || artifact.targetCount <= 0
      || !Number.isInteger(artifact.totalExecutions) || artifact.totalExecutions <= artifact.targetCount
      || !Number.isInteger(artifact.coverageRanges) || artifact.coverageRanges <= 0
      || artifact.iterationsPerTarget !== 2000 || artifact.maxInputBytes !== 1024 || artifact.maxCorpus !== 256 || artifact.maxRuntimeMs !== 20000 || artifact.coverageSampleInterval !== 16
      || !Number.isInteger(artifact.seed) || artifact.seed <= 0) errors.push('INVALID_FUZZ_EVIDENCE');
  }
  if (gate === 'sbom') {
    const artifact = receipt.artifact;
    if (!artifact || artifact.kind !== 'spdx-json' || !SHA256.test(artifact.sha256 ?? '') || !Number.isInteger(artifact.bytes) || artifact.bytes <= 0) errors.push('INVALID_SBOM_EVIDENCE');
  }
  if (['sast', 'secrets', 'sca', 'config-scan', 'image-scan'].includes(gate)) {
    const scan = receipt.scan;
    const findings = Array.isArray(receipt.findings) ? receipt.findings : [];
    if (!scan || !Number.isInteger(scan.scannerExitCode)
      || !SHA256.test(scan.rawReportSha256 ?? '') || !Number.isInteger(scan.rawReportBytes) || scan.rawReportBytes <= 0
      || !SHA256.test(scan.toolchainReportSha256 ?? '') || scan.sourceBindingSha256 !== sourceBindingSha256
      || !Number.isInteger(scan.normalizedFindingCount) || scan.normalizedFindingCount !== findings.length
      || receipt.scanError !== undefined) errors.push('INVALID_SCAN_EVIDENCE');
    if (gate === 'image-scan') {
      const images = receipt.images;
      if (!SHA256.test(scan?.imageIdentitiesSha256 ?? '') || !Array.isArray(images) || images.length === 0
        || images.some((image, index) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(image?.component ?? '')
          || (typeof image?.reference !== 'string' || !image.reference || /\s|@|(?:^|:)latest$/iu.test(image.reference))
          || !/^sha256:[0-9a-f]{64}$/u.test(image?.digest ?? '')
          || (index > 0 && images[index - 1].component >= image.component))) errors.push('INVALID_IMAGE_SCAN_IDENTITY');
    }
  }
  if (gate === 'provenance') {
    const statement = receipt.statement; const bundle = receipt.bundle; const publicKey = receipt.publicKey;
    if (!statement || statement.predicateType !== 'https://slsa.dev/provenance/v1'
      || !SHA256.test(statement.sha256 ?? '') || !Number.isInteger(statement.bytes) || statement.bytes <= 0
      || !Number.isInteger(statement.subjectCount) || statement.subjectCount < 2
      || !SHA256.test(statement.releaseManifestSha256 ?? '') || !SHA256.test(statement.releaseManifestDigest ?? '') || !SHA256.test(statement.sbomSha256 ?? '')
      || !bundle || bundle.mediaType !== 'application/vnd.dev.sigstore.bundle.v0.3+json'
      || !SHA256.test(bundle.sha256 ?? '') || !Number.isInteger(bundle.bytes) || bundle.bytes <= 0
      || !SHA256.test(bundle.signedStatementSha256 ?? '') || !Number.isInteger(bundle.signedStatementBytes) || bundle.signedStatementBytes <= 0
      || !publicKey || !SHA256.test(publicKey.sha256 ?? '') || !Number.isInteger(publicKey.bytes) || publicKey.bytes <= 0) errors.push('INVALID_PROVENANCE_EVIDENCE');
  }
  return errors;
}

function validBaseline(gate, finding) {
  return baselineEntries.some((entry) =>
    entry?.gate === gate &&
    entry?.fingerprint === finding.fingerprint &&
    String(entry?.severity ?? '').toUpperCase() === String(finding.severity ?? '').toUpperCase() &&
    String(entry?.category ?? '').toLowerCase() === String(finding.category ?? '').toLowerCase() &&
    /^[0-9a-f]{40}$/u.test(entry?.firstObservedCommit ?? '') &&
    typeof entry?.ownerApprovedBy === 'string' && Boolean(entry.ownerApprovedBy.trim()) &&
    typeof entry?.reason === 'string' && Boolean(entry.reason.trim())
  );
}

function validException(gate, finding) {
  const ex = exceptionEntries.find((entry) => entry?.gate === gate && entry?.fingerprint === finding.fingerprint);
  if (!ex) return false;
  if (policy.exceptionPolicy?.requireOwnerApproval && (typeof ex.ownerApprovedBy !== 'string' || !ex.ownerApprovedBy.trim())) return false;
  if (policy.exceptionPolicy?.requireReason && (typeof ex.reason !== 'string' || !ex.reason.trim())) return false;
  if (policy.exceptionPolicy?.requireExpiry) {
    const expiry = new Date(ex.expiresAt ?? '');
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= evaluatedAt.getTime()) return false;
  }
  return true;
}

for (const gate of policy.requiredGates) {
  const file = join(evidenceDir, `${gate}.json`);
  if (!existsSync(file)) {
    failures.push({ gate, code: 'MISSING_EVIDENCE' });
    continue;
  }
  let receipt;
  const bytes = readFileSync(file);
  try { receipt = JSON.parse(bytes.toString('utf8')); }
  catch { failures.push({ gate, code: 'MALFORMED_EVIDENCE' }); continue; }
  receipts.push({ gate, path: file, sha256: sha256(bytes) });
  if (receipt.schemaVersion !== 1 || receipt.gate !== gate) failures.push({ gate, code: 'INVALID_RECEIPT_IDENTITY' });
  if (!sameSource(receipt.source, source)) failures.push({ gate, code: 'STALE_OR_DIRTY_SOURCE_BINDING' });
  if (receipt.status !== 'PASS') failures.push({ gate, code: 'GATE_NOT_PASS', status: receipt.status ?? null });
  const contract = policy.gateContracts?.[gate];
  if (contract?.passAllowed === false && receipt.status === 'PASS') {
    failures.push({ gate, code: 'GATE_PASS_NOT_ALLOWED', failureCode: contract.failureCode ?? 'GATE_NOT_INTEGRATED' });
  }
  const expectedTool = policy.expectedTools?.[gate];
  if (expectedTool && (receipt.tool?.name !== expectedTool.name || receipt.tool?.version !== expectedTool.version)) {
    failures.push({ gate, code: 'TOOL_VERSION_MISMATCH', expected: expectedTool, observed: receipt.tool ?? null });
  }
  // UNAVAILABLE is an honest prerequisite classification, not a claimed execution PASS.
  // It still blocks release, but PASS-only proof fields are intentionally absent.
  if (receipt.status !== 'UNAVAILABLE') {
    for (const code of validateReceiptEvidence(gate, receipt, sha256(readFileSync(sourceBindingPath)))) failures.push({ gate, code });
  }
  for (const finding of Array.isArray(receipt.findings) ? receipt.findings : []) {
    if (typeof finding.fingerprint !== 'string' || !finding.fingerprint) {
      failures.push({ gate, code: 'FINDING_WITHOUT_FINGERPRINT' });
      continue;
    }
    const severity = String(finding.severity ?? 'UNKNOWN').toUpperCase();
    const category = String(finding.category ?? 'other').toLowerCase();
    const critical = policy.findingPolicy.alwaysBlockSeverities.includes(severity);
    const sensitive = policy.findingPolicy.alwaysBlockCategories.includes(category);
    const baselineEligible = policy.findingPolicy.baselineEligibleSeverities.includes(severity);
    if (critical || sensitive) {
      failures.push({ gate, code: 'BLOCKING_FINDING', fingerprint: finding.fingerprint, severity, category });
      continue;
    }
    if (baselineEligible) {
      if (validBaseline(gate, finding)) tolerated.push({ gate, fingerprint: finding.fingerprint, disposition: 'BASELINE' });
      else if (validException(gate, finding)) tolerated.push({ gate, fingerprint: finding.fingerprint, disposition: 'OWNER_EXCEPTION' });
      else failures.push({ gate, code: 'NEW_HIGH_FINDING', fingerprint: finding.fingerprint, severity, category });
    }
  }
}

const ok = failures.length === 0;
const report = {
  schemaVersion: 1,
  evaluatedAt: evaluatedAt.toISOString(),
  source,
  sourceBinding: { sha256: sha256(readFileSync(sourceBindingPath)) },
  ok,
  verdict: ok ? 'PASS' : 'FAIL',
  requiredGateCount: policy.requiredGates.length,
  evidence: receipts.sort((a, b) => a.gate.localeCompare(b.gate)),
  tolerated: tolerated.sort((a, b) => `${a.gate}:${a.fingerprint}`.localeCompare(`${b.gate}:${b.fingerprint}`)),
  failures,
};
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(resolve(output), rendered); else process.stdout.write(rendered);
if (!ok) process.exit(3);
