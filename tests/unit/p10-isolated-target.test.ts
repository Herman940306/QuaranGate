import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isolatedTargetPlan } from '../../scripts/p10-isolated-target.mjs';

describe('P10 isolated integration target launcher', () => {
  it('requires a noncanonical target project distinct from the core project', () => {
    expect(() => isolatedTargetPlan({}, ['config'])).toThrow(/QG_P10_TARGET_PROJECT/u);
    expect(() => isolatedTargetPlan({ QG_P10_TARGET_PROJECT: 'mcp-ide-bridge-testtarget' }, ['config'])).toThrow(/canonical integration target/u);
    expect(() => isolatedTargetPlan({ QG_P10_TARGET_PROJECT: 'qg-p10', QG_P10_COMPOSE_PROJECT: 'qg-p10' }, ['config'])).toThrow(/must differ/u);
  });

  it('derives unique container and image identities', () => {
    const plan = isolatedTargetPlan({ QG_P10_TARGET_PROJECT: 'quarangate-p10-candidate-target', QG_P10_COMPOSE_PROJECT: 'quarangate-p10-candidate' }, ['config']);
    expect(plan.childEnv).toMatchObject({
      QG_P10_TARGET_IMAGE: 'mcp-bridge-testtarget:quarangate-p10-candidate-target',
      QG_P10_TARGET_DEV_CONTAINER: 'quarangate-p10-candidate-target-dev',
      QG_P10_TARGET_DECOY_CONTAINER: 'quarangate-p10-candidate-target-decoy',
      QG_P10_TARGET_DECOY_IMAGE: 'alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc',
    });
  });

  it('does not allow project/file override forwarding', () => {
    const env = { QG_P10_TARGET_PROJECT: 'qg-p10-target' };
    expect(() => isolatedTargetPlan(env, ['-p', 'mcp-ide-bridge-testtarget', 'ps'])).toThrow(/may not override/u);
    expect(() => isolatedTargetPlan(env, ['--file=/tmp/x', 'ps'])).toThrow(/may not override/u);
  });

  it('overlay replaces hard-coded target identities', () => {
    const overlay = readFileSync(new URL('../../test-target/compose.p10-isolated.yaml', import.meta.url), 'utf8');
    expect(overlay).toContain('name: ${QG_P10_TARGET_PROJECT:?');
    expect(overlay).toContain('container_name: ${QG_P10_TARGET_DEV_CONTAINER:?');
    expect(overlay).toContain('container_name: ${QG_P10_TARGET_DECOY_CONTAINER:?');
    expect(overlay).not.toContain('mcp-bridge-testtarget-dev');
    expect(overlay).not.toContain('mcp-bridge-testtarget-decoy');
    expect(overlay).toContain('network: none');
    expect(overlay).toContain('pull: false');
    expect((overlay.match(/pull_policy: never/gu) ?? []).length).toBe(2);
    expect(overlay).toContain('QG_P10_TARGET_DECOY_IMAGE');
  });
});
