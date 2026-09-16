#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const config = JSON.parse(readFileSync('security/release-toolchain.json', 'utf8'));
const args = process.argv.slice(2);
const reportOnly = args.includes('--report-only');
const outAt = args.indexOf('--output');
const output = outAt >= 0 ? args[outAt + 1] : undefined;
if (outAt >= 0 && !output) throw new Error('--output requires a path');

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
  const escapedVersion = String(tool.version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Require a complete semver-like token: do not accept 1.2.3.4, 1.2.3-rc1, etc.
  const exactVersion = new RegExp(`(?:^|[^0-9A-Za-z.+-])v?${escapedVersion}(?:$|[^0-9A-Za-z.+-])`).test(combined);
  return {
    id: tool.id,
    required: Boolean(tool.required),
    expectedVersion: tool.version,
    status: exactVersion ? 'PASS' : 'VERSION_MISMATCH',
    observed: combined.slice(0, 300),
  };
}

const tools = config.tools.map(check);
const ok = tools.every((tool) => !tool.required || tool.status === 'PASS');
const report = {
  schemaVersion: 1,
  acquisitionPolicy: config.acquisitionPolicy,
  ok,
  tools,
};
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(resolve(output), rendered); else process.stdout.write(rendered);
if (!ok && !reportOnly) process.exit(2);
