import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isolatedComposePlan } from '../../scripts/p10-isolated-compose.mjs';

const ENV = { QG_P10_COMPOSE_PROJECT: 'qg-p10', QG_P10_BRIDGE_PORT: '18787', QG_P10_CONFIG_DIR: '/tmp/qg-p10-config' };

describe('P10 isolated Compose launcher', () => {
  it('requires an explicit isolated project, bridge port, and external config directory', () => {
    expect(() => isolatedComposePlan({}, ['config'])).toThrow(/QG_P10_COMPOSE_PROJECT is required/u);
    expect(() => isolatedComposePlan({ QG_P10_COMPOSE_PROJECT: 'qg-p10' }, ['config'])).toThrow(/QG_P10_BRIDGE_PORT/u);
    expect(() => isolatedComposePlan({ QG_P10_COMPOSE_PROJECT: 'qg-p10', QG_P10_BRIDGE_PORT: '18787' }, ['config'])).toThrow(/QG_P10_CONFIG_DIR/u);
  });

  it('refuses canonical identity, live/default port, relative config, and in-source config', () => {
    expect(() => isolatedComposePlan({ ...ENV, QG_P10_COMPOSE_PROJECT: 'quarangate' }, ['config'])).toThrow(/refusing canonical/u);
    expect(() => isolatedComposePlan({ ...ENV, QG_P10_BRIDGE_PORT: '8787' }, ['config'])).toThrow(/non-live/u);
    expect(() => isolatedComposePlan({ ...ENV, QG_P10_CONFIG_DIR: 'relative' }, ['config'])).toThrow(/must be absolute/u);
    expect(() => isolatedComposePlan({ ...ENV, QG_P10_CONFIG_DIR: new URL('../../config', import.meta.url).pathname }, ['config'])).toThrow(/outside the QuaranGate source tree/u);
  });

  it('derives a closed set of project-owned physical resources and isolated public URL', () => {
    const plan = isolatedComposePlan({ QG_P10_COMPOSE_PROJECT: 'quarangate-p10-candidate', QG_P10_BRIDGE_PORT: '18787', QG_P10_CONFIG_DIR: '/tmp/qg-p10-config' }, ['config', '--format', 'json']);
    expect(plan.project).toBe('quarangate-p10-candidate');
    expect(plan.bridgePort).toBe(18787);
    expect(plan.configDir).toBe('/tmp/qg-p10-config');
    expect(plan.childEnv).toMatchObject({
      QG_P10_EDGE_NETWORK: 'quarangate-p10-candidate-edge',
      QG_P10_INTERNAL_NETWORK: 'quarangate-p10-candidate-internal',
      QG_P10_DATA_VOLUME: 'quarangate-p10-candidate-data',
      QG_P10_JOBS_VOLUME: 'quarangate-p10-candidate-jobs',
      BRIDGE_PORT: '18787',
      BRIDGE_PUBLIC_URL: 'http://127.0.0.1:18787',
      QG_P10_CONFIG_DIR: '/tmp/qg-p10-config',
    });
    expect(plan.dockerArgs.slice(0, 7)).toEqual(['compose', '-p', 'quarangate-p10-candidate', '-f', plan.composeFiles[0], '-f', plan.composeFiles[1]]);
  });

  it('does not allow forwarded arguments to replace the guarded project or files', () => {
    expect(() => isolatedComposePlan(ENV, ['-p', 'quarangate', 'ps'])).toThrow(/may not override/u);
    expect(() => isolatedComposePlan(ENV, ['--project-name=quarangate', 'ps'])).toThrow(/may not override/u);
    expect(() => isolatedComposePlan(ENV, ['-f', '/tmp/unsafe.yaml', 'ps'])).toThrow(/may not override/u);
  });

  it('overlay replaces /config from an explicit external bind and never redefines live physical names', () => {
    const overlay = readFileSync(new URL('../../compose.p10-isolated.yaml', import.meta.url), 'utf8');
    expect(overlay.split('source: ${QG_P10_CONFIG_DIR:').length - 1).toBe(3);
    expect((overlay.match(/target: \/config/gu) ?? []).length).toBe(3);
    expect(overlay).toContain('BRIDGE_PUBLIC_URL: http://127.0.0.1:${QG_P10_BRIDGE_PORT:');
    for (const live of ['name: quarangate-edge', 'name: quarangate-internal', 'name: quarangate-data', 'name: mcp-bridge-jobs']) expect(overlay).not.toContain(live);
  });
});
