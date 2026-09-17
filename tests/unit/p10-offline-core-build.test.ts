import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASE_IMAGE, assertNoRegistryActivity, localBasePlan } from '../../scripts/offline-local-base.mjs';
import { coreBuildPlan } from '../../scripts/p10-offline-core-build.mjs';

describe('P10 local-only core build', () => {
  it('requires exact absolute source/bundle paths and source commit', () => {
    expect(() => coreBuildPlan([])).toThrow(/source-root/u);
    expect(() => coreBuildPlan(['--source-root', 'relative', '--source-commit', 'a'.repeat(40), '--bundle', '/tmp/b', '--output-image', 'qg:test'])).toThrow(/source-root must be absolute/u);
    expect(() => coreBuildPlan(['--source-root', '/tmp/s', '--source-commit', 'bad', '--bundle', '/tmp/b', '--output-image', 'qg:test'])).toThrow(/40 lowercase hex/u);
  });

  it('binds the approved pinned base to a unique local image context', () => {
    const imageId = `sha256:${'1'.repeat(64)}`;
    const plan = localBasePlan(imageId, 'abc-123');
    expect(plan.baseImage).toBe(BASE_IMAGE);
    expect(plan.tempTag).toBe('quarangate-p10-local-node-base:abc-123');
    expect(plan.buildContext).toBe(`${BASE_IMAGE}=docker-image://${plan.tempTag}`);
  });

  it('fails closed on BuildKit registry metadata or auth activity', () => {
    for (const sample of [
      '[auth] library/node:pull token for registry-1.docker.io',
      'load metadata for docker.io/library/node:24-alpine',
      'resolve docker.io/library/node:24-alpine',
    ]) expect(() => assertNoRegistryActivity(sample)).toThrow(/registry metadata\/auth activity/u);
    expect(() => assertNoRegistryActivity('load metadata for quarangate-p10-local-node-base:abc')).not.toThrow();
  });

  it('uses a local base override and keeps build RUN networking disabled', () => {
    const source = readFileSync(new URL('../../scripts/p10-offline-core-build.mjs', import.meta.url), 'utf8');
    expect(source).toContain("'--network=none', '--pull=false', '--no-cache'");
    expect(source).toContain("'--build-context', localBase.buildContext");
    expect(source).toContain("assertNoRegistryActivity(combined)");
    expect(source).toContain("spawnSync('docker', ['image', 'rm', localBase.tempTag]");
  });
});
