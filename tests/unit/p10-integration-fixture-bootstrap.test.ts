import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureBootstrapPlan } from '../../scripts/p10-integration-fixture-bootstrap.mjs';

const BASE = [
  '--output-dir', '/tmp/qg-fixture',
  '--source-root', '/tmp/qg-source',
  '--source-commit', 'a'.repeat(40),
  '--core-project', 'qg-p10-core',
  '--target-project', 'qg-p10-target',
  '--bridge-port', '18787',
  '--bundle', '/tmp/qg-bundle',
];

describe('P10 integration fixture dependency bootstrap', () => {
  it('requires absolute source, output, and bundle paths plus an exact commit', () => {
    expect(() => fixtureBootstrapPlan(BASE.map((v) => v === '/tmp/qg-source' ? 'relative' : v))).toThrow(/source-root must be absolute/u);
    expect(() => fixtureBootstrapPlan(BASE.map((v) => v === 'a'.repeat(40) ? 'bad' : v))).toThrow(/40 lowercase hex/u);
  });

  it('forwards the exact source binding and fixture authority arguments', () => {
    const plan = fixtureBootstrapPlan(BASE);
    expect(plan.sourceCommit).toBe('a'.repeat(40));
    expect(plan.generatorArgs).toEqual(BASE);
  });

  it('has no third-party module dependency at bootstrap time', () => {
    const source = readFileSync(new URL('../../scripts/p10-integration-fixture-bootstrap.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"](?!node:)/u);
    expect(source).not.toContain("from 'yaml'");
  });

  it('uses only the verified offline dependency path and removes its detached worktree', () => {
    const source = readFileSync(new URL('../../scripts/p10-integration-fixture-bootstrap.mjs', import.meta.url), 'utf8');
    expect(source).toContain("'materialize'");
    expect(source).toContain("'--offline'");
    expect(source).toContain("'--ignore-scripts'");
    expect(source).toContain("'worktree', 'add', '--detach'");
    expect(source).toContain("'worktree', 'remove', '--force'");
  });
});
