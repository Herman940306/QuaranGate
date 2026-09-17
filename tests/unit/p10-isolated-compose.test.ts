import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isolatedComposePlan } from '../../scripts/p10-isolated-compose.mjs';

describe('P10 isolated Compose launcher', () => {
  it('requires an explicit isolated project and bridge port', () => {
    expect(() => isolatedComposePlan({}, ['config'])).toThrow(/QG_P10_COMPOSE_PROJECT is required/u);
    expect(() => isolatedComposePlan({ QG_P10_COMPOSE_PROJECT: 'qg-p10' }, ['config'])).toThrow(/QG_P10_BRIDGE_PORT/u);
  });

  it('refuses the canonical project and live/default gateway port', () => {
    expect(() => isolatedComposePlan({ QG_P10_COMPOSE_PROJECT: 'quarangate', QG_P10_BRIDGE_PORT: '18787' }, ['config'])).toThrow(/refusing canonical/u);
    expect(() => isolatedComposePlan({ QG_P10_COMPOSE_PROJECT: 'qg-p10', QG_P10_BRIDGE_PORT: '8787' }, ['config'])).toThrow(/non-live/u);
  });

  it('derives a closed set of project-owned physical resources', () => {
    const plan = isolatedComposePlan({ QG_P10_COMPOSE_PROJECT: 'quarangate-p10-candidate', QG_P10_BRIDGE_PORT: '18787' }, ['config', '--format', 'json']);
    expect(plan.project).toBe('quarangate-p10-candidate');
    expect(plan.bridgePort).toBe(18787);
    expect(plan.childEnv).toMatchObject({
      QG_P10_EDGE_NETWORK: 'quarangate-p10-candidate-edge',
      QG_P10_INTERNAL_NETWORK: 'quarangate-p10-candidate-internal',
      QG_P10_DATA_VOLUME: 'quarangate-p10-candidate-data',
      QG_P10_JOBS_VOLUME: 'quarangate-p10-candidate-jobs',
      BRIDGE_PORT: '18787',
    });
    expect(plan.dockerArgs.slice(0, 7)).toEqual([
      'compose', '-p', 'quarangate-p10-candidate', '-f', plan.composeFiles[0], '-f', plan.composeFiles[1],
    ]);
  });

  it('does not allow forwarded arguments to replace the guarded project or files', () => {
    const env = { QG_P10_COMPOSE_PROJECT: 'qg-p10', QG_P10_BRIDGE_PORT: '18787' };
    expect(() => isolatedComposePlan(env, ['-p', 'quarangate', 'ps'])).toThrow(/may not override/u);
    expect(() => isolatedComposePlan(env, ['--project-name=quarangate', 'ps'])).toThrow(/may not override/u);
    expect(() => isolatedComposePlan(env, ['-f', '/tmp/unsafe.yaml', 'ps'])).toThrow(/may not override/u);
  });

  it('overlay requires all physical names and does not redefine live defaults', () => {
    const overlay = readFileSync(new URL('../../compose.p10-isolated.yaml', import.meta.url), 'utf8');
    expect(overlay).toContain('name: ${QG_P10_COMPOSE_PROJECT:?');
    expect(overlay).toContain('name: ${QG_P10_EDGE_NETWORK:?');
    expect(overlay).toContain('name: ${QG_P10_INTERNAL_NETWORK:?');
    expect(overlay).toContain('name: ${QG_P10_DATA_VOLUME:?');
    expect(overlay).toContain('name: ${QG_P10_JOBS_VOLUME:?');
    expect(overlay).not.toContain('name: quarangate-edge');
    expect(overlay).not.toContain('name: quarangate-internal');
    expect(overlay).not.toContain('name: quarangate-data');
    expect(overlay).not.toContain('name: mcp-bridge-jobs');
  });
});
