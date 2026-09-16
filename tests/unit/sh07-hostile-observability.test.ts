import { describe, expect, it, vi } from 'vitest';
import { audit, queryAuditActivity, resetAuditActivityForTests } from '../../src/gateway/audit.js';

function captureAuditWrite(fn: () => void): string {
  let captured = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write);
  try { fn(); } finally { spy.mockRestore(); }
  return captured;
}

describe('SH-07 hostile observability inputs', () => {
  it('redacts credential-shaped material and safely JSON-frames control characters', () => {
    resetAuditActivityForTests();
    const bearer = 'sh07-bearer-secret-value';
    const apiKey = 'mcpb_sh07_adversarial_secret_123456789';
    const password = 'sh07-password-secret';
    const hostile = `Authorization: Bearer ${bearer}\napi_key=${apiKey}\rpassword=${password}\u0000tail`;

    const output = captureAuditWrite(() => audit({
      reqId: 'sh07-observability',
      principal: 'principal-sh07',
      tool: 'terminal_exec',
      target: 'bounded-target',
      decision: 'deny',
      code: 'FORBIDDEN_SCOPE',
      detail: hostile,
    }));

    expect(output).not.toContain(bearer);
    expect(output).not.toContain(apiKey);
    expect(output).not.toContain(password);
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('\u0000tail'.replace('\\u0000', '\u0000'));
    expect(() => JSON.parse(output.trim())).not.toThrow();
    expect(JSON.parse(output.trim())).toMatchObject({
      reqId: 'sh07-observability', principal: 'principal-sh07', decision: 'deny', code: 'FORBIDDEN_SCOPE',
    });

    // The operator-facing retained activity surface deliberately drops detail
    // altogether, so hostile caller text cannot be read back through Control Center.
    const retained = queryAuditActivity({ principal: 'principal-sh07', limit: 10 });
    expect(retained).toHaveLength(1);
    expect(retained[0]).not.toHaveProperty('detail');
    expect(JSON.stringify(retained)).not.toContain('secret');
  });
});
