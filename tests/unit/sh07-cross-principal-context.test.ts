import { describe, expect, it } from 'vitest';
import { currentPrincipal, withPrincipal } from '../../src/gateway/context.js';
import type { Principal } from '../../src/gateway/config.js';

const principal = (id: string): Principal => ({
  id, name: id, keyHash: id.padEnd(64, '0').slice(0, 64), enabled: true,
  scopes: ['files:read'], targets: [id], projects: [], agentBackends: [], agentProfiles: [],
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SH-07 concurrent principal isolation', () => {
  it('never leaks AsyncLocalStorage identity across heavily interleaved requests', async () => {
    const ids = Array.from({ length: 64 }, (_, i) => `principal-${i}`);
    const observations = await Promise.all(ids.map((id, i) => withPrincipal(principal(id), async () => {
      const seen: string[] = [];
      for (let n = 0; n < 12; n++) {
        if ((n + i) % 3 === 0) await tick();
        else await Promise.resolve();
        seen.push(currentPrincipal()?.id ?? 'MISSING');
      }
      return seen;
    })));
    observations.forEach((seen, i) => expect(new Set(seen)).toEqual(new Set([ids[i]])));
    expect(currentPrincipal()).toBeUndefined();
  });

  it('restores the outer principal after nested delegation and exceptions', async () => {
    const outer = principal('outer'); const inner = principal('inner');
    await withPrincipal(outer, async () => {
      expect(currentPrincipal()?.id).toBe('outer');
      await expect(withPrincipal(inner, async () => { await tick(); throw new Error('hostile nested failure'); })).rejects.toThrow('hostile nested failure');
      expect(currentPrincipal()?.id).toBe('outer');
    });
    expect(currentPrincipal()).toBeUndefined();
  });
});
