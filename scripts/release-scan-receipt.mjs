#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const valueAfter = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const gate = valueAfter('--gate');
const input = valueAfter('--input');
const sourceBindingPath = valueAfter('--source-binding');
const toolchainReportPath = valueAfter('--toolchain-report');
const exitCodeRaw = valueAfter('--scanner-exit-code');
const output = valueAfter('--output');
const allowedGates = new Set(['sast', 'secrets', 'sca', 'config-scan', 'image-scan']);
if (!allowedGates.has(gate)) throw new Error('--gate must be one of sast,secrets,sca,config-scan,image-scan');
if (!input || !existsSync(input)) throw new Error('--input requires an existing scanner JSON report');
if (!sourceBindingPath || !existsSync(sourceBindingPath)) throw new Error('--source-binding requires an existing source-binding receipt');
if (!toolchainReportPath || !existsSync(toolchainReportPath)) throw new Error('--toolchain-report requires an existing toolchain report');
if (!/^-?\d+$/u.test(exitCodeRaw ?? '')) throw new Error('--scanner-exit-code requires an integer');
if (!output) throw new Error('--output is required');
const scannerExitCode = Number(exitCodeRaw);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (path, label) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`${label} is malformed JSON`); } };
const cleanText = (value, max = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max) : '';
const severity = (value, fallback = 'HIGH') => {
  const v = String(value ?? '').toUpperCase();
  if (v === 'CRITICAL') return 'CRITICAL';
  if (v === 'HIGH' || v === 'ERROR') return 'HIGH';
  if (v === 'MEDIUM' || v === 'WARNING' || v === 'WARN') return 'MEDIUM';
  if (v === 'LOW' || v === 'INFO') return 'LOW';
  return fallback;
};
const fingerprint = (...parts) => sha256(Buffer.from(parts.map((part) => String(part ?? '')).join('\0'), 'utf8'));

const sourceBinding = readJson(sourceBindingPath, 'source-binding receipt');
const source = sourceBinding.source;
if (sourceBinding.schemaVersion !== 1 || sourceBinding.gate !== 'source-binding' || sourceBinding.status !== 'PASS' || source?.clean !== true || !/^[0-9a-f]{40}$/u.test(source?.commit ?? '') || !/^[0-9a-f]{40}$/u.test(source?.tree ?? '')) {
  throw new Error('source-binding receipt is not a valid exact clean source receipt');
}
const policy = readJson('security/release-policy.json', 'release policy');
const expectedTool = policy.expectedTools?.[gate];
if (!expectedTool) throw new Error(`release policy has no expected tool for gate ${gate}`);
const toolIds = { sast: 'semgrep', secrets: 'gitleaks', sca: 'osv-scanner', 'config-scan': 'trivy', 'image-scan': 'trivy' };
const toolId = toolIds[gate];
const toolchain = readJson(toolchainReportPath, 'toolchain report');
const tool = Array.isArray(toolchain.tools) ? toolchain.tools.find((item) => item?.id === toolId) : null;
if (!tool || tool.status !== 'PASS' || tool.expectedVersion !== expectedTool.version) {
  throw new Error(`toolchain report does not prove pinned ${toolId}@${expectedTool.version}`);
}
if (toolId === 'gitleaks' && tool.functionalCanary?.status !== 'PASS') {
  throw new Error('toolchain report does not prove the Gitleaks functional canary');
}

const rawBytes = readFileSync(input);
let raw;
try { raw = JSON.parse(rawBytes.toString('utf8')); } catch { throw new Error('scanner report is malformed JSON'); }
const findings = [];
let scanError = null;

function addFinding(entry) {
  findings.push({
    fingerprint: entry.fingerprint,
    severity: entry.severity,
    category: entry.category,
    ruleId: cleanText(entry.ruleId, 160) || undefined,
    path: cleanText(entry.path, 400) || undefined,
    line: Number.isInteger(entry.line) && entry.line > 0 ? entry.line : undefined,
    package: cleanText(entry.package, 220) || undefined,
    version: cleanText(entry.version, 120) || undefined,
    message: cleanText(entry.message, 400) || undefined,
  });
}

if (gate === 'sast') {
  if (!raw || !Array.isArray(raw.results) || !Array.isArray(raw.errors ?? [])) scanError = 'invalid Semgrep JSON shape';
  else if ((raw.errors ?? []).length) scanError = 'Semgrep report contains scanner errors';
  else {
    for (const item of raw.results) {
      const ruleId = item?.check_id;
      const path = item?.path;
      const line = item?.start?.line;
      addFinding({
        fingerprint: fingerprint('semgrep', item?.extra?.fingerprint, ruleId, path, line, item?.start?.col, item?.end?.line, item?.end?.col),
        severity: severity(item?.extra?.severity, 'HIGH'),
        category: 'code', ruleId, path, line,
        message: item?.extra?.message,
      });
    }
    if (scannerExitCode === 1 && findings.length === 0) scanError = 'Semgrep exit 1 without findings is ambiguous/error';
    else if (scannerExitCode === 0 && findings.length > 0) scanError = 'Semgrep findings present with exit 0; required --error contract not proven';
    else if (![0, 1].includes(scannerExitCode)) scanError = `Semgrep scanner error exit ${scannerExitCode}`;
  }
} else if (gate === 'secrets') {
  if (!Array.isArray(raw)) scanError = 'invalid Gitleaks JSON shape';
  else {
    for (const item of raw) {
      const secret = cleanText(item?.Secret, 80);
      const match = cleanText(item?.Match, 80);
      if ((secret && !/^REDACTED$/iu.test(secret)) || (match && !/^REDACTED$/iu.test(match))) {
        scanError = 'Gitleaks report contains unredacted secret material';
        break;
      }
      const ruleId = item?.RuleID;
      const path = item?.File;
      const line = item?.StartLine;
      addFinding({
        fingerprint: fingerprint('gitleaks', item?.Fingerprint, ruleId, path, line, item?.Commit),
        severity: 'HIGH', category: 'secret', ruleId, path, line,
        message: ruleId ? `secret rule ${ruleId}` : 'secret detected',
      });
    }
    if (!scanError) {
      if (scannerExitCode === 1 && findings.length === 0) scanError = 'Gitleaks exit 1 without findings is ambiguous/error';
      else if (scannerExitCode === 0 && findings.length > 0) scanError = 'Gitleaks findings present with exit 0; findings exit contract not proven';
      else if (![0, 1].includes(scannerExitCode)) scanError = `Gitleaks scanner error exit ${scannerExitCode}`;
    }
  }
} else if (gate === 'sca') {
  if (!raw || !Array.isArray(raw.results)) scanError = 'invalid OSV-Scanner JSON shape';
  else {
    for (const result of raw.results) {
      for (const pkg of Array.isArray(result?.packages) ? result.packages : []) {
        const identity = pkg?.package ?? {};
        for (const vuln of Array.isArray(pkg?.vulnerabilities) ? pkg.vulnerabilities : []) {
          const id = vuln?.id;
          const explicit = vuln?.database_specific?.severity ?? vuln?.severity?.find?.((s) => typeof s?.score === 'string' && /CRITICAL|HIGH|MEDIUM|LOW/iu.test(s.score))?.score;
          addFinding({
            fingerprint: fingerprint('osv', id, identity?.ecosystem, identity?.name, identity?.version, result?.source?.path),
            // Unknown OSV severity is fail-safe CRITICAL: it must not become baseline-waivable HIGH.
            severity: severity(explicit, 'CRITICAL'), category: 'dependency', ruleId: id,
            path: result?.source?.path, package: identity?.name, version: identity?.version,
            message: vuln?.summary ?? id,
          });
        }
      }
    }
    if (scannerExitCode === 1 && findings.length === 0) scanError = 'OSV-Scanner exit 1 without normalized findings is ambiguous/error';
    else if (scannerExitCode === 0 && findings.length > 0) scanError = 'OSV-Scanner vulnerabilities present with exit 0';
    else if (![0, 1].includes(scannerExitCode)) scanError = `OSV-Scanner non-result/error exit ${scannerExitCode}`;
  }
} else {
  if (!raw || raw.SchemaVersion !== 2 || !Array.isArray(raw.Results)) scanError = 'invalid Trivy JSON shape';
  else {
    for (const result of raw.Results) {
      const target = result?.Target;
      // Normalize every supported Trivy finding class even if a future/incorrect runner enables
      // more scanners than the nominal gate. Unexpected findings must never disappear at receipt time.
      for (const item of Array.isArray(result?.Misconfigurations) ? result.Misconfigurations : []) {
        addFinding({
          fingerprint: fingerprint('trivy-config', item?.ID, item?.AVDID, target, item?.CauseMetadata?.StartLine),
          severity: severity(item?.Severity, 'CRITICAL'), category: 'configuration', ruleId: item?.ID ?? item?.AVDID,
          path: target, line: item?.CauseMetadata?.StartLine, message: item?.Title ?? item?.Description,
        });
      }
      for (const item of Array.isArray(result?.Vulnerabilities) ? result.Vulnerabilities : []) {
        addFinding({
          fingerprint: fingerprint('trivy-vuln', item?.VulnerabilityID, target, item?.PkgName, item?.InstalledVersion),
          severity: severity(item?.Severity, 'CRITICAL'), category: 'dependency', ruleId: item?.VulnerabilityID,
          path: target, package: item?.PkgName, version: item?.InstalledVersion, message: item?.Title,
        });
      }
      for (const item of Array.isArray(result?.Secrets) ? result.Secrets : []) {
        addFinding({
          fingerprint: fingerprint('trivy-secret', item?.RuleID, target, item?.StartLine),
          severity: 'HIGH', category: 'secret', ruleId: item?.RuleID, path: target, line: item?.StartLine,
          message: item?.Title ?? (item?.RuleID ? `secret rule ${item.RuleID}` : 'secret detected'),
        });
      }
    }
    if (scannerExitCode === 1 && findings.length === 0) scanError = 'Trivy exit 1 without normalized findings is ambiguous/error';
    else if (scannerExitCode === 0 && findings.length > 0) scanError = 'Trivy findings present with exit 0; required --exit-code 1 contract not proven';
    else if (![0, 1].includes(scannerExitCode)) scanError = `Trivy scanner error exit ${scannerExitCode}`;
  }
}

findings.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
const receipt = {
  schemaVersion: 1,
  gate,
  status: scanError ? 'FAIL' : 'PASS',
  source,
  tool: { name: expectedTool.name, version: expectedTool.version },
  scan: {
    scannerExitCode,
    rawReportSha256: sha256(rawBytes),
    rawReportBytes: rawBytes.length,
    toolchainReportSha256: sha256(readFileSync(toolchainReportPath)),
    sourceBindingSha256: sha256(readFileSync(sourceBindingPath)),
    normalizedFindingCount: findings.length,
  },
  findings,
  ...(scanError ? { scanError } : {}),
};
writeFileSync(resolve(output), `${JSON.stringify(receipt, null, 2)}\n`);
if (scanError) process.exit(4);
