import { describe, it, expect } from 'vitest';
import { checkRate } from '../../src/gateway/ratelimit.js';
import { BridgeError } from '../../src/shared/errors.js';

describe('rate limiter', () => {
  it('allows within limit and blocks beyond', () => {
    const id = 'rl-' + Math.random();
    for (let i = 0; i < 5; i++) checkRate(id, 5);
    expect(() => checkRate(id, 5)).toThrow(BridgeError);
  });

  it('no limit means unlimited', () => {
    const id = 'rl-none-' + Math.random();
    for (let i = 0; i < 1000; i++) checkRate(id, undefined);
    expect(true).toBe(true);
  });
});
