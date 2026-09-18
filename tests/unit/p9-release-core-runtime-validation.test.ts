import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../scripts/p9-production-release-material.mjs', import.meta.url),
  'utf8',
);

function validateCoreImageBlock(): string {
  const start = source.indexOf('function validateCoreImage(plan) {');
  const end = source.indexOf('\nfunction validateProjectsWorkSeed(plan) {', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('P9 release core runtime validation contract', () => {
  it('runs the core image probe as the configured non-root image user', () => {
    const block = validateCoreImageBlock();

    expect(block).toContain(`'[ "$(id -u)" -ne 0 ]'`);
    expect(block).not.toContain(`'--user', '0:0'`);
    expect(block).toContain(`'--network', 'none'`);
    expect(block).toContain(`'--read-only'`);
    expect(block).toContain(`'--cap-drop=ALL'`);
    expect(block).toContain(`'no-new-privileges:true'`);
    expect(block).toContain(`'--pull=never'`);
  });

  it('requires runtime package and application bytes to be readable by that user', () => {
    const block = validateCoreImageBlock();

    expect(block).toContain(`'test -r /app/package.json'`);
    expect(block).toContain(`'test "$(stat -c %a /app/package.json)" = "644"'`);
    expect(block).toContain(`readFileSync(\\'/app/package.json\\', \\'utf8\\')`);
    expect(block).toContain(`'test -r /app/dist/gateway/index.js'`);
    expect(block).toContain(`'test -r /app/dist/executor/index.js'`);
    expect(block).toContain(`'test -r /app/dist/installer/cli.js'`);
    expect(block).toContain(`'test -r /app/dist/lifecycle/productionDriver.js'`);
    expect(block).toContain(`'test -r /app/console/app.js'`);
    expect(block).toContain(`'test -r /app/console/index.html'`);
    expect(block).toContain(`'test -r /app/node_modules/yaml/package.json'`);
    expect(block).toContain(`'test -r /app/node_modules/zod/package.json'`);
  });

  it('preserves provenance and source-free runtime checks', () => {
    const block = validateCoreImageBlock();

    expect(block).toContain('core image revision label does not match source commit');
    expect(block).toContain('core image source label does not match QuaranGate source');
    expect(block).toContain('1358f1be32dc2a0dd8084dbda675c3b3dde8352b519b7b8a65573262551ad0fc');
    expect(block).toContain(`'test ! -e /app/src'`);
    expect(block).toContain(`'test ! -e /app/.git'`);
    expect(block).toContain(`'test ! -e /app/.env'`);
    expect(block).toContain(`'test ! -e /npm-deps'`);
  });
});
