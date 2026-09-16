import { Pool } from 'undici';
import { BridgeError } from '../shared/errors.js';
import type { DockerAuthorityOperation } from './policy.js';

const URL = process.env.DOCKER_AUTHORITY_URL ?? 'http://docker-authority:8991';
const TOKEN = process.env.DOCKER_AUTHORITY_TOKEN ?? process.env.INTERNAL_TOKEN ?? '';
const pool = new Pool(URL, { connections: 16 });

export async function authorityCall<T>(op: DockerAuthorityOperation, payload: Record<string, unknown> = {}): Promise<T> {
  if (!TOKEN) throw new BridgeError('DOCKER_UNAVAILABLE', 'docker authority token is not configured', 503);
  const res = await pool.request({ method: 'POST', path: '/v1/operation', headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN }, body: JSON.stringify({ op, payload }) }).catch((e: Error) => {
    throw new BridgeError('DOCKER_UNAVAILABLE', `docker authority unreachable: ${e.message}`, 503);
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) throw new BridgeError(res.statusCode === 403 ? 'FORBIDDEN_POLICY' : 'DOCKER_UNAVAILABLE', `docker authority rejected ${op}: ${res.statusCode} ${text.slice(0, 200)}`, res.statusCode === 403 ? 403 : 502);
  return text ? JSON.parse(text) as T : undefined as T;
}
