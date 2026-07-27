/** Client principal configuration + loading. */
import fs from 'node:fs';
import YAML from 'yaml';

export type Scope =
  | 'targets:read'
  | 'files:read'
  | 'files:write'
  | 'files:delete'
  | 'terminal:exec'
  | 'git:read'
  | 'process:read';

export const ALL_SCOPES: Scope[] = [
  'targets:read',
  'files:read',
  'files:write',
  'files:delete',
  'terminal:exec',
  'git:read',
  'process:read',
];

export interface Principal {
  id: string;
  name: string;
  keyHash: string; // sha256 hex of the API key
  scopes: Scope[];
  targets: string[]; // explicit ids, or ["*"] for all CONFIGURED targets
  enabled: boolean;
  rateLimit?: number; // requests per minute
}

interface ClientsFile {
  clients: Principal[];
}

let principals: Principal[] = [];

export function loadClients(path = process.env.CLIENTS_CONFIG ?? '/config/clients.yaml'): void {
  if (!fs.existsSync(path)) {
    principals = [];
    return;
  }
  const parsed = YAML.parse(fs.readFileSync(path, 'utf8')) as ClientsFile | null;
  principals = (parsed?.clients ?? []).map((p) => ({
    ...p,
    enabled: p.enabled !== false,
    scopes: (p.scopes ?? []).filter((s): s is Scope => ALL_SCOPES.includes(s as Scope)),
    targets: p.targets ?? [],
  }));
  const seen = new Set<string>();
  for (const p of principals) {
    if (!p.id || !p.keyHash) throw new Error(`client missing id or keyHash`);
    if (seen.has(p.id)) throw new Error(`duplicate client id: ${p.id}`);
    seen.add(p.id);
  }
}

export function allPrincipals(): Principal[] {
  return principals;
}

export function principalByKeyHash(hash: string): Principal | undefined {
  return principals.find((p) => timingSafeEqualHex(p.keyHash, hash));
}

export function principalById(id: string): Principal | undefined {
  return principals.find((p) => p.id === id);
}

/** Constant-time-ish compare over equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function principalCanTarget(p: Principal, targetId: string): boolean {
  return p.targets.includes('*') || p.targets.includes(targetId);
}

export function principalHasScope(p: Principal, scope: Scope): boolean {
  return p.scopes.includes(scope);
}
