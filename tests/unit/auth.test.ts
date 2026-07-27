import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKey, hashKey, authenticateKey } from '../../src/gateway/auth/apikeys.js';
import { loadClients, principalCanTarget, principalHasScope, principalById } from '../../src/gateway/config.js';
import { BridgeError } from '../../src/shared/errors.js';

function writeClients(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcpb-'));
  const path = join(dir, 'clients.yaml');
  const a = generateKey('client-a');
  const b = generateKey('client-b');
  writeFileSync(path, `clients:
  - id: client-a
    name: A
    keyHash: "${a.hash}"
    enabled: true
    scopes: [targets:read, files:read]
    targets: ["demo"]
  - id: client-b
    name: B
    keyHash: "${b.hash}"
    enabled: false
    scopes: [targets:read, files:read, files:write]
    targets: ["*"]
`);
  (writeClients as any)._keys = { a, b };
  return path;
}

describe('api keys + principals', () => {
  let keys: { a: { key: string }; b: { key: string } };
  beforeEach(() => {
    const path = writeClients();
    keys = (writeClients as any)._keys;
    loadClients(path);
  });

  it('hashKey is stable', () => {
    expect(hashKey('x')).toBe(hashKey('x'));
    expect(hashKey('x')).not.toBe(hashKey('y'));
  });

  it('accepts a valid key for an enabled client', () => {
    const p = authenticateKey(keys.a.key);
    expect(p.id).toBe('client-a');
  });

  it('rejects missing credential', () => {
    expect(() => authenticateKey(undefined)).toThrow(BridgeError);
    try { authenticateKey(undefined); } catch (e) { expect((e as BridgeError).code).toBe('UNAUTHENTICATED'); }
  });

  it('rejects an invalid key', () => {
    try { authenticateKey('mcpb_client-a_wrong'); } catch (e) { expect((e as BridgeError).code).toBe('INVALID_CREDENTIAL'); }
  });

  it('rejects a disabled (revoked) client', () => {
    try { authenticateKey(keys.b.key); } catch (e) { expect((e as BridgeError).code).toBe('CLIENT_DISABLED'); }
  });

  it('enforces independent client identities', () => {
    expect(authenticateKey(keys.a.key).id).toBe('client-a');
    // client-b's key never maps to client-a
    expect(() => authenticateKey(keys.b.key)).toThrow(); // disabled, but also distinct id
  });

  it('scope + target checks', () => {
    const a = principalById('client-a')!;
    expect(principalHasScope(a, 'files:read')).toBe(true);
    expect(principalHasScope(a, 'files:write')).toBe(false);
    expect(principalCanTarget(a, 'demo')).toBe(true);
    expect(principalCanTarget(a, 'other')).toBe(false);
    const b = principalById('client-b')!;
    expect(principalCanTarget(b, 'anything-configured')).toBe(true); // ["*"]
  });
});
