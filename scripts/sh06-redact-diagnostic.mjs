#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 240;

export function redactDiagnostic(value) {
  const text = String(value);
  if (text.length === 0) return 'no health output';
  // Health-command output is an untrusted secret-bearing channel. A lexical
  // redactor cannot prove that arbitrary credentials, job contents, or future
  // token formats were removed, so expose metadata only and never echo bytes.
  return `health output present (content redacted, chars=${Math.min(text.length, MAX_OUTPUT_CHARS)}${text.length > MAX_OUTPUT_CHARS ? '+' : ''})`;
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      process.stdout.write('health output exceeded safe bound\n');
      return;
    }
    chunks.push(chunk);
  }
  try {
    const rows = JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? [];
    const output = Array.isArray(rows) && rows.length > 0 ? rows.at(-1)?.Output : 'no health output';
    process.stdout.write(`${redactDiagnostic(output)}\n`);
  } catch {
    process.stdout.write('health output unavailable\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
