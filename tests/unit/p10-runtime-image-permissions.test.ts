import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderOfflineDockerfile } from '../../scripts/offline-local-base.mjs';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const acceptance = readFileSync(
  new URL('../../scripts/accept-npm-offline-build.mjs', import.meta.url),
  'utf8',
);

function runtimeValidationBlock(): string {
  const start = acceptance.indexOf('async function runtimeImageValidation(image, containerName)');
  expect(start).toBeGreaterThanOrEqual(0);
  const next = acceptance.indexOf('\nasync function ', start + 10);
  return acceptance.slice(start, next >= 0 ? next : undefined);
}

describe('P10 runtime image permission contract', () => {
  it('normalizes runtime payload permissions before dropping to USER node', () => {
    const normalize = 'chmod -R u=rwX,go=rX /app/node_modules /app/dist /app/console';
    const packageMode = 'chmod 0644 /app/package.json';
    expect(dockerfile).toContain(
      'chown -R root:root /app/node_modules /app/dist /app/console /app/package.json',
    );
    expect(dockerfile).toContain(normalize);
    expect(dockerfile).toContain(packageMode);
    const lines = dockerfile.split('\n');
    const normalizeLine = lines.findIndex((line) => line.includes(normalize));
    const packageModeLine = lines.findIndex((line) => line.includes(packageMode));
    const userDirectiveLine = lines.findIndex((line) => line.trim() === 'USER node');
    expect(normalizeLine).toBeGreaterThanOrEqual(0);
    expect(packageModeLine).toBeGreaterThanOrEqual(0);
    expect(userDirectiveLine).toBeGreaterThanOrEqual(0);
    expect(normalizeLine).toBeLessThan(userDirectiveLine);
    expect(packageModeLine).toBeLessThan(userDirectiveLine);
  });

  it('preserves normalization in the offline Dockerfile rewrite', () => {
    const rendered = renderOfflineDockerfile(dockerfile);
    expect(rendered).toContain('chmod -R u=rwX,go=rX /app/node_modules /app/dist /app/console');
    expect(rendered).toContain('chmod 0644 /app/package.json');
    expect(rendered).toContain('USER node');
  });

  it('validates the built image as its configured non-root user', () => {
    const block = runtimeValidationBlock();
    expect(block).toContain(`'[ "$(id -u)" -ne 0 ]'`);
    expect(block).toContain(`'test -r /app/package.json'`);
    expect(block).toContain(`'test "$(stat -c %a /app/package.json)" = "644"'`);
    expect(block).toContain(`'test -r /app/dist/gateway/index.js'`);
    expect(block).toContain(`'test -r /app/dist/executor/index.js'`);
    expect(block).toContain(`'test -r /app/console/app.js'`);
    expect(block).toContain(`'test -r /app/console/index.html'`);
    expect(block).not.toContain(`'--user', '0:0'`);
  });
});
