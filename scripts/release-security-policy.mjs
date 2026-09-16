#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const valueAfter = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const evidenceDir = valueAfter('--evidence-dir');
const sourceBindingPath = valueAfter('--source-binding');
const output = valueAfter('--output');
const policyPath = valueAfter('--policy') ?? 'security/release-policy.json';
const baselinePath = valueAfter('--baseline') ?? 'security/release-baseline.json';
const exceptionsPath = valueAfter('--exceptions') ?? 'security/release-exceptions.json';
const atRaw = valueAfter('--at') ?? new Date().toISOString();
if (!evidenceDir) throw new Error('--evidence-dir is required');
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
  const expectedTool = policy.expectedTools?.[gate];
  if (expectedTool && (receipt.tool?.name !== expectedTool.name || receipt.tool?.version !== expectedTool.version)) {
    failures.push({ gate, code: 'TOOL_VERSION_MISMATCH', expected: expectedTool, observed: receipt.tool ?? null });
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
