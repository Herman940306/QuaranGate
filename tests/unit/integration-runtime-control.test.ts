import { describe, expect, it } from 'vitest';
import { integrationRuntimeControl } from '../integration/runtime-control.js';

describe('destructive integration runtime control', () => {
  it('fails closed when the Compose project is not explicit', () => {
    expect(() => integrationRuntimeControl({ BRIDGE_URL: 'http://127.0.0.1:9876' })).toThrow(/QG_INTEGRATION_COMPOSE_PROJECT is required/u);
  });

  it('refuses the canonical live project unless separately opted in', () => {
    expect(() => integrationRuntimeControl({
      QG_INTEGRATION_COMPOSE_PROJECT: 'quarangate',
      BRIDGE_URL: 'http://127.0.0.1:9876',
    })).toThrow(/refusing to restart canonical Compose project/u);
  });

  it('requires an explicit loopback HTTP bridge endpoint', () => {
    expect(() => integrationRuntimeControl({ QG_INTEGRATION_COMPOSE_PROJECT: 'quarangate-p10-test' })).toThrow(/BRIDGE_URL must be explicitly set/u);
    expect(() => integrationRuntimeControl({
      QG_INTEGRATION_COMPOSE_PROJECT: 'quarangate-p10-test',
      BRIDGE_URL: 'https://example.com:9876',
    })).toThrow(/must use loopback HTTP/u);
  });

  it('accepts an isolated Compose project bound to an explicit loopback gateway', () => {
    expect(integrationRuntimeControl({
      QG_INTEGRATION_COMPOSE_PROJECT: 'quarangate-p10-test',
      BRIDGE_URL: 'http://127.0.0.1:9876',
    })).toEqual({ project: 'quarangate-p10-test', bridgeUrl: 'http://127.0.0.1:9876' });
  });

  it('requires an explicit override before canonical-project restart', () => {
    expect(integrationRuntimeControl({
      QG_INTEGRATION_COMPOSE_PROJECT: 'quarangate',
      QG_INTEGRATION_ALLOW_CANONICAL_RESTART: '1',
      BRIDGE_URL: 'http://localhost:8787/',
    })).toEqual({ project: 'quarangate', bridgeUrl: 'http://localhost:8787' });
  });
});
