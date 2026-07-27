import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from '../config.js';
import { principalByKeyHash } from '../config.js';
import { BridgeError } from '../../shared/errors.js';

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateKey(clientId: string): { key: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  const key = `mcpb_${clientId}_${raw}`;
  return { key, hash: hashKey(key) };
}

/** Resolve a raw bearer/key value to an enabled principal, or throw. */
export function authenticateKey(rawKey: string | undefined): Principal {
  if (!rawKey) throw new BridgeError('UNAUTHENTICATED', 'missing credential', 401);
  const p = principalByKeyHash(hashKey(rawKey.trim()));
  if (!p) throw new BridgeError('INVALID_CREDENTIAL', 'invalid credential', 401);
  if (!p.enabled) throw new BridgeError('CLIENT_DISABLED', 'client disabled', 403);
  return p;
}
