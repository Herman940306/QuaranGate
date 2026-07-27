import { describe, it, expect } from 'vitest';
import { redact } from '../../src/shared/redact.js';

describe('redact', () => {
  it('redacts bridge API keys', () => {
    const out = redact('using mcpb_vscode_abcDEF123456789_token here');
    expect(out).not.toContain('mcpb_vscode_abcDEF123456789');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts bearer headers', () => {
    expect(redact('Authorization: Bearer sk-secret-value')).toContain('[REDACTED]');
    expect(redact('Authorization: Bearer sk-secret-value')).not.toContain('sk-secret-value');
  });

  it('redacts key=value secrets', () => {
    expect(redact('export API_KEY=supersecret')).not.toContain('supersecret');
    expect(redact('password: hunter2')).not.toContain('hunter2');
  });

  it('leaves ordinary text intact', () => {
    expect(redact('ls -la /workspace/src')).toBe('ls -la /workspace/src');
  });
});
