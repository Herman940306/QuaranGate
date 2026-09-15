import { describe, expect, it } from 'vitest';
import { createLifecycleEvidence } from '../../src/lifecycle/evidence.js';

describe('P9 bounded lifecycle evidence', () => {
  it('records only bounded identities and redacts common credential shapes', () => {
    const evidence = createLifecycleEvidence({
      operationId: 'op-evidence-001',
      action: 'UPGRADE',
      state: 'ROLLED_BACK',
      planDigest: 'a'.repeat(64),
      productVersion: '0.2.0',
      errorCode: 'UPGRADE_FAILED',
      detail: 'authorization: Bearer raw-token token=secret-value ghp_abcdefghijklmnopqrstuvwxyz123456 sk-abcdefghijklmnopqrstuvwxyz',
      paths: ['/var/lib/quarangate/config', '/var/lib/quarangate/state'],
    });
    const json = JSON.stringify(evidence);
    expect(json).not.toContain('raw-token');
    expect(json).not.toContain('secret-value');
    expect(json).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(json).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(evidence.paths.every((path) => path.identityDigest.match(/^[0-9a-f]{64}$/u))).toBe(true);
    expect(evidence.paths.map((path) => path.label)).toEqual(['config', 'state']);
  });

  it('bounds detail and path counts and rejects control characters', () => {
    const input = {
      operationId: 'op-evidence-002',
      action: 'REPAIR' as const,
      state: 'SUCCESS' as const,
      planDigest: 'b'.repeat(64),
      productVersion: '0.1.0',
      detail: 'x'.repeat(20_000),
      paths: Array.from({ length: 30 }, (_, index) => `/tmp/path-${String(index).padStart(2, '0')}`),
    };
    const evidence = createLifecycleEvidence(input);
    expect(evidence.detail.length).toBeLessThanOrEqual(1024);
    expect(evidence.paths).toHaveLength(20);
    expect(() => createLifecycleEvidence({ ...input, operationId: 'bad\noperation' })).toThrow(/operation/u);
  });
});
