#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const path = '/app/dist/executor/agents/jobStore.js';
const source = readFileSync(path, 'utf8');
const matches = [...source.matchAll(/(?:export\s+)?const\s+AGENT_JOB_SCHEMA_VERSION\s*=\s*([0-9]+)\s*;/gu)];
if (matches.length !== 1) {
  process.stderr.write('SH06_IMAGE_SCHEMA_PROBE=FAIL reason=exact schema declaration unavailable\n');
  process.exit(1);
}
const version = Number(matches[0]?.[1]);
if (!Number.isSafeInteger(version) || version < 0) {
  process.stderr.write('SH06_IMAGE_SCHEMA_PROBE=FAIL reason=invalid schema declaration\n');
  process.exit(1);
}
process.stdout.write(`${version}\n`);
