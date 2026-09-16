#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const valueAfter = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const evidenceDir = valueAfter('--evidence-dir');
const commit = valueAfter('--commit');
const imageDigest = valueAfter('--image-digest');
const sbomPath = valueAfter('--sbom');
const policyReportPath = valueAfter('--policy-report');
const output = valueAfter('--output');
if (!evidenceDir) throw new Error('--evidence-dir is required');
if (!commit || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error('--commit requires an exact 40-hex Git commit');
if (!imageDigest || !/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) throw new Error('--image-digest requires sha256:<64 lowercase hex>');
if (!sbomPath || !existsSync(sbomPath)) throw new Error('--sbom requires an existing SPDX JSON file');
if (!policyReportPath || !existsSync(policyReportPath)) throw new Error('--policy-report requires an existing release-policy report');
if (!output) throw new Error('--output is required');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const policy = JSON.parse(readFileSync('security/release-policy.json', 'utf8'));
const policyBytes = readFileSync(policyReportPath);
let policyReport;
try { policyReport = JSON.parse(policyBytes.toString('utf8')); }
catch { throw new Error('release-policy report is malformed JSON'); }
if (policyReport.schemaVersion !== 1 || policyReport.verdict !== 'PASS' || policyReport.ok !== true) {
  throw new Error('release-policy report is not a PASS receipt');
}
if (policyReport.commit !== commit) throw new Error('release-policy report commit does not match --commit');

const sbomBytes = readFileSync(sbomPath);
let sbom;
try { sbom = JSON.parse(sbomBytes.toString('utf8')); }
catch { throw new Error('SBOM is malformed JSON'); }
if (sbom.spdxVersion !== 'SPDX-2.3' || sbom.SPDXID !== 'SPDXRef-DOCUMENT') {
  throw new Error('SBOM is not the expected SPDX-2.3 document');
}

const evidence = [];
const testCounts = {};
for (const gate of policy.requiredGates) {
  const path = join(evidenceDir, `${gate}.json`);
  if (!existsSync(path)) throw new Error(`missing required gate receipt: ${gate}`);
  const bytes = readFileSync(path);
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`malformed required gate receipt: ${gate}`); }
  if (receipt.schemaVersion !== 1 || receipt.gate !== gate || receipt.status !== 'PASS') {
    throw new Error(`gate receipt is not an exact PASS receipt: ${gate}`);
  }
  if (receipt.source?.commit !== commit || receipt.source?.clean !== true) {
    throw new Error(`gate receipt source binding mismatch: ${gate}`);
  }
  const expectedTool = policy.expectedTools?.[gate];
  if (expectedTool && (receipt.tool?.name !== expectedTool.name || receipt.tool?.version !== expectedTool.version)) {
    throw new Error(`gate receipt tool binding mismatch: ${gate}`);
  }
  if (['unit', 'integration', 'e2e'].includes(gate)) {
    const counts = receipt.testCounts;
    if (!counts || !Number.isInteger(counts.files) || counts.files <= 0 || !Number.isInteger(counts.tests) || counts.tests <= 0 || !Number.isInteger(counts.failed) || counts.failed !== 0) {
      throw new Error(`gate receipt lacks valid passing test counts: ${gate}`);
    }
    testCounts[gate] = { files: counts.files, tests: counts.tests, failed: counts.failed };
  }
  evidence.push({ gate, sha256: sha256(bytes), bytes: bytes.length });
}

const policyEvidence = new Map((policyReport.evidence ?? []).map((entry) => [entry.gate, entry.sha256]));
for (const item of evidence) {
  if (policyEvidence.get(item.gate) !== item.sha256) {
    throw new Error(`release-policy evidence hash mismatch: ${item.gate}`);
  }
}

evidence.sort((a, b) => a.gate.localeCompare(b.gate));
const source = {
  repository: 'https://github.com/Herman940306/QuaranGate.git',
  commit,
  clean: true,
};
const subject = { imageDigest };
const artifacts = {
  sbom: { path: sbomPath, sha256: sha256(sbomBytes), bytes: sbomBytes.length, format: 'SPDX-2.3' },
  policyReport: { path: policyReportPath, sha256: sha256(policyBytes), bytes: policyBytes.length },
};
const bindingArtifacts = {
  sbom: { sha256: artifacts.sbom.sha256, bytes: artifacts.sbom.bytes, format: artifacts.sbom.format },
  policyReport: { sha256: artifacts.policyReport.sha256, bytes: artifacts.policyReport.bytes },
};
const bindingInput = Buffer.from(JSON.stringify({ source, subject, artifacts: bindingArtifacts, evidence, testCounts }), 'utf8');
const bundle = {
  schemaVersion: 1,
  source,
  subject,
  artifacts,
  testCounts,
  evidence,
  bundleBindingSha256: sha256(bindingInput),
};
writeFileSync(resolve(output), `${JSON.stringify(bundle, null, 2)}\n`);
