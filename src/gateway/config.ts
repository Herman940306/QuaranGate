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
  | 'process:read'
  | 'agents:read'
  | 'agents:dispatch'
  | 'agents:cancel'
  | 'agents:apply';

export const ALL_SCOPES: Scope[] = [
  'targets:read',
  'files:read',
  'files:write',
  'files:delete',
  'terminal:exec',
  'git:read',
  'process:read',
  'agents:read',
  'agents:dispatch',
  'agents:cancel',
  'agents:apply',
];

export interface Principal {
  id: string;
  name: string;
  keyHash: string; // sha256 hex of the API key
  scopes: Scope[];
  targets: string[]; // explicit ids, or ["*"] for all CONFIGURED targets
  enabled: boolean;
  rateLimit?: number; // requests per minute
  /**
   * Agent Control Plane grants, enforced on every registered agent tool call.
   * Missing/empty = DENY. "*" = every entry in the TRUSTED CONFIGURED agent
   * registry, never arbitrary host resources. Target permission does NOT
   * imply project permission, and agent scopes alone grant nothing without
   * the matching resource grant.
   */
  projects?: string[]; // logical agent project ids, or ["*"]
  agentBackends?: string[]; // agent backend ids, or ["*"]
  agentProfiles?: string[]; // agent profile ids, or ["*"]
}

interface ClientsFile {
  clients: Principal[];
}

/** Why a clients-config load failed. Category only — never file content. */
export type ClientsLoadFailureReason = 'not_found' | 'read_error' | 'parse_error' | 'schema_invalid';

/**
 * Explicit, queryable outcome of the last clients-config load.
 *
 * `loaded` with `principalCount: 0` is a VALID configuration and must stay
 * distinguishable from `failed`: a missing/unreadable/malformed/invalid file is
 * a failure, not an empty allowlist. `message` is a safe diagnostic and never
 * carries file contents, key hashes, tokens, or other credential material.
 */
export type ClientsLoadState =
  | { status: 'not_loaded' }
  | { status: 'loaded'; principalCount: number }
  | { status: 'failed'; reason: ClientsLoadFailureReason; message: string };

let principals: Principal[] = [];
let loadState: ClientsLoadState = { status: 'not_loaded' };

/** Current clients-config load state. Fail closed: only `loaded` means usable. */
export function clientsLoadState(): ClientsLoadState {
  return loadState;
}

/** Record a load failure and drop every principal (fail closed). */
function failLoad(reason: ClientsLoadFailureReason, message: string): Error {
  principals = [];
  loadState = { status: 'failed', reason, message };
  return new Error(message);
}

/** Non-content parse diagnostics from the YAML error, if it exposes them. */
function yamlErrorDetail(e: unknown): string {
  const err = e as { code?: unknown; linePos?: Array<{ line?: number }> };
  const code = typeof err?.code === 'string' ? err.code : 'UNKNOWN';
  const line = typeof err?.linePos?.[0]?.line === 'number' ? err.linePos[0].line : undefined;
  return line === undefined ? `code=${code}` : `code=${code}, line=${line}`;
}

export function loadClients(path = process.env.CLIENTS_CONFIG ?? '/config/clients.yaml'): void {
  if (!fs.existsSync(path)) {
    // Previously a silent empty allowlist, which made a lost /config mount look
    // like a valid zero-client config. It is now an explicit load failure.
    failLoad('not_found', 'clients config file not found');
    return;
  }
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    throw failLoad('read_error', 'clients config file could not be read');
  }

  let parsed: ClientsFile | null;
  try {
    parsed = YAML.parse(text) as ClientsFile | null;
  } catch (e) {
    throw failLoad('parse_error', `clients config is not valid YAML (${yamlErrorDetail(e)})`);
  }

  if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw failLoad('schema_invalid', 'clients config root must be a mapping');
  }
  const rawClients = parsed?.clients ?? [];
  if (!Array.isArray(rawClients)) {
    throw failLoad('schema_invalid', 'clients config "clients" must be a list');
  }

  const loaded: Principal[] = rawClients.map((p) => ({
    ...p,
    enabled: p.enabled !== false,
    scopes: (p.scopes ?? []).filter((s): s is Scope => ALL_SCOPES.includes(s as Scope)),
    targets: p.targets ?? [],
    // Agent grants default to DENY: absent fields become empty allowlists.
    projects: p.projects ?? [],
    agentBackends: p.agentBackends ?? [],
    agentProfiles: p.agentProfiles ?? [],
  }));
  const seen = new Set<string>();
  for (const p of loaded) {
    if (!p.id || !p.keyHash) throw failLoad('schema_invalid', `client missing id or keyHash`);
    if (seen.has(p.id)) throw failLoad('schema_invalid', `duplicate client id: ${p.id}`);
    seen.add(p.id);
  }
  principals = loaded;
  loadState = { status: 'loaded', principalCount: loaded.length };
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
