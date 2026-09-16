#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { externalOutputPath } from './release-path-safety.mjs';

const config = JSON.parse(readFileSync('security/release-toolchain.json', 'utf8'));
const args = process.argv.slice(2);
const reportOnly = args.includes('--report-only');
const outAt = args.indexOf('--output');
const output = outAt >= 0 ? args[outAt + 1] : undefined;
const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
if (outAt >= 0 && !output) throw new Error('--output requires a path');
if (output) externalOutputPath(SOURCE_ROOT, output, '--output');

function exactVersionPresent(outputText, version) {
  const escapedVersion = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Require a complete semver-like token: do not accept 1.2.3.4, 1.2.3-rc1, etc.
  return new RegExp(`(?:^|[^0-9A-Za-z.+-])v?${escapedVersion}(?:$|[^0-9A-Za-z.+-])`).test(outputText);
}

function gitleaksFunctionalCanary(tool) {
  const dir = mkdtempSync(join(tmpdir(), 'qg-gitleaks-canary-'));
  try {
    const source = join(dir, 'canary.txt');
    const report = join(dir, 'report.json');
    // Deliberately assembled at runtime so repository secret scans do not see a static PAT-shaped token.
    const suffix = ['aBcDeFgHiJkLmNoPqRsTuVwXyZ', '0123456789'].join('');
    writeFileSync(source, `token = "${['ghp', '_', suffix].join('')}"\n`, { mode: 0o600 });
    const result = spawnSync(tool.binary, [
      'dir', '--no-banner', '--no-color', '--redact=100', '--report-format', 'json', '--report-path', report, source,
    ], { encoding: 'utf8' });
    let findings = [];
    try { findings = JSON.parse(readFileSync(report, 'utf8')); } catch { /* fail below */ }
    const detected = result.status === 1 && Array.isArray(findings) && findings.length > 0;
    return {
      id: 'github-pat-detection',
      status: detected ? 'PASS' : 'FAIL',
      scannerExitCode: result.status,
      findingCount: Array.isArray(findings) ? findings.length : 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(tool) {
  const result = spawnSync(tool.binary, tool.versionArgs ?? ['--version'], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    return { id: tool.id, required: Boolean(tool.required), expectedVersion: tool.version, status: 'ABSENT' };
  }
  if (result.error) {
    return { id: tool.id, required: Boolean(tool.required), expectedVersion: tool.version, status: 'ERROR', detail: result.error.message.slice(0, 300) };
  }
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    return { id: tool.id, required: Boolean(tool.required), expectedVersion: tool.version, status: 'ERROR', exitCode: result.status, detail: combined.slice(0, 300) };
  }
  if (!exactVersionPresent(combined, tool.version)) {
    return { id: tool.id, required: Boolean(tool.required), expectedVersion: tool.version, status: 'VERSION_MISMATCH', observed: combined.slice(0, 300) };
  }
  let functionalCanary;
  if (tool.functionalCanary === 'github-pat-detection') {
    functionalCanary = gitleaksFunctionalCanary(tool);
    if (functionalCanary.status !== 'PASS') {
      return { id: tool.id, required: Boolean(tool.required), expectedVersion: tool.version, status: 'FUNCTIONAL_CANARY_FAILED', observed: combined.slice(0, 300), functionalCanary };
    }
  }
  return {
    id: tool.id,
    required: Boolean(tool.required),
    expectedVersion: tool.version,
    status: 'PASS',
    observed: combined.slice(0, 300),
    ...(functionalCanary ? { functionalCanary } : {}),
  };
}

const tools = config.tools.map(check);
const ok = tools.every((tool) => !tool.required || tool.status === 'PASS');
const report = { schemaVersion: 1, acquisitionPolicy: config.acquisitionPolicy, ok, tools };
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(resolve(output), rendered); else process.stdout.write(rendered);
if (!ok && !reportOnly) process.exit(2);
