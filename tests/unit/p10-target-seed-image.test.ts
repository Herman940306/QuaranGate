import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { targetSeedPlan } from '../../scripts/p10-target-seed-image.mjs';

describe('P10 local target seed qualification', () => {
  it('requires distinct bounded image refs and an exact source commit', () => {
    expect(() => targetSeedPlan([])).toThrow(/--seed-image is required/u);
    expect(() => targetSeedPlan(['--seed-image', 'mcp-bridge-testtarget:latest', '--output-image', 'mcp-bridge-testtarget:latest', '--source-commit', 'a'.repeat(40)])).toThrow(/must differ/u);
    expect(() => targetSeedPlan(['--seed-image', 'mcp-bridge-testtarget:latest', '--output-image', 'mcp-bridge-testtarget:qg-p10', '--source-commit', 'bad'])).toThrow(/40 lowercase hex/u);
  });

  it('derives a stable candidate binding identity without changing requested refs', () => {
    const commit = '1'.repeat(40);
    const plan = targetSeedPlan(['--seed-image', 'mcp-bridge-testtarget:latest', '--output-image', 'mcp-bridge-testtarget:quarangate-p10-candidate-target', '--source-commit', commit], 4242);
    expect(plan).toMatchObject({
      seedImage: 'mcp-bridge-testtarget:latest',
      outputImage: 'mcp-bridge-testtarget:quarangate-p10-candidate-target',
      sourceCommit: commit,
      suffix: '111111111111-4242',
      sourceUrl: 'https://github.com/Herman940306/QuaranGate',
    });
  });

  it('probes the complete target fixture/tool contract without network', () => {
    const plan = targetSeedPlan(['--seed-image', 'seed:local', '--output-image', 'out:local', '--source-commit', '2'.repeat(40)], 7);
    for (const token of ['git', 'grep', 'find', 'ps', 'yes', 'head', '/workspace/README.md', '/workspace/src/app.ts', '/secretzone/secret.txt', 'escape-passwd', 'escape-dir', 'rev-parse', 'TARGET_SEED_CONTRACT=PASS']) {
      expect(plan.probeScript).toContain(token);
    }
  });

  it('binds the qualified seed locally without BuildKit or registry resolution', () => {
    const source = readFileSync(new URL('../../scripts/p10-target-seed-image.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^import .* from ['"](?!node:|\.\.?\/)/mu);
    expect(source).toContain("'run', '--rm', '--pull=never', '--network', 'none'");
    expect(source).toContain("'image', 'tag', seedId, plan.outputImage");
    expect(source).toContain('outputId !== seedId');
    expect(source).toContain("bindingType: 'qualified-local-seed-tag'");
    expect(source).toContain('registryActivity: false');
    expect(source).toContain("'{{json .RootFS.Layers}}'");
    expect(source).toContain("'image', 'rm', '-f', plan.outputImage");
    expect(source).not.toContain("'buildx', 'build'");
    expect(source).not.toContain('oci-layout://');
  });
});
