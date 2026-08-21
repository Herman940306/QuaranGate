/**
 * G3 — gateway config load state + readiness/liveness separation.
 *
 * Incident: after a host reboot the gateway's /config bind mount was empty, so
 * clients.yaml could not load and ALL client authentication failed, yet
 * /healthz returned 200 and Docker reported the container healthy.
 *
 * These tests drive the REAL src/gateway/index.ts route handlers (express and
 * the executor client replaced by recorders, no socket bound) and the REAL
 * src/gateway/config.ts loader, plus static assertions over compose.yaml.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { ClientsLoadState } from '../../src/gateway/config.js';

// ---------------------------------------------------------------------------
// Recorders — hoisted so the vi.mock factories can close over them.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
  const executorReady = { value: true };
  return { routes, executorReady };
});

vi.mock('express', () => {
  const app = {
    disable: () => app,
    use: () => app,
    get: (path: string, ...handlers: Array<(req: unknown, res: unknown) => unknown>) => {
      const last = handlers[handlers.length - 1];
      if (last) h.routes.set(`GET ${path}`, last);
      return app;
    },
    post: (path: string, ...handlers: Array<(req: unknown, res: unknown) => unknown>) => {
      const last = handlers[handlers.length - 1];
      if (last) h.routes.set(`POST ${path}`, last);
      return app;
    },
    delete: () => app,
    listen: (_port: number, _host: string, cb?: () => void) => {
      cb?.();
      return { close: (done?: () => void) => done?.() };
    },
  };
  const express = Object.assign(() => app, {
    json: () => (_r: unknown, _s: unknown, next: () => void) => next(),
    urlencoded: () => (_r: unknown, _s: unknown, next: () => void) => next(),
  });
  return { default: express };
});

// Executor reachability is controlled per test; no network is touched.
vi.mock('../../src/gateway/executorClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gateway/executorClient.js')>();
  return { ...actual, executor: { ...actual.executor, readyz: async () => h.executorReady.value } };
});

// The OAuth façade touches DATA_DIR at mount time and is out of scope here.
vi.mock('../../src/gateway/auth/oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/gateway/auth/oauth.js')>()),
  mountOAuth: () => {},
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeRes {
  statusCode: number;
  body: unknown;
  done: boolean;
}

function makeRes(): FakeRes & { status(c: number): FakeRes; json(b: unknown): FakeRes; setHeader(): void } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    done: false,
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; res.done = true; return res; },
    setHeader() {},
  };
  return res;
}

let tmp: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitCodes: number[] = [];
let exitSpy: { mockRestore(): void };
/** Anything the process would have died from if the load call site rethrew. */
let uncaught: unknown[] = [];

function onUncaught(e: unknown): void { uncaught.push(e); }

/** Import the real gateway entrypoint fresh against the current env. */
async function startGateway(): Promise<ClientsLoadState> {
  h.routes.clear();
  vi.resetModules();
  await import('../../src/gateway/index.js');
  const cfg = await import('../../src/gateway/config.js');
  return cfg.clientsLoadState();
}

/** Invoke a captured route handler and wait for its response. */
async function callRoute(key: string): Promise<{ status: number; body: unknown }> {
  const handler = h.routes.get(key);
  if (!handler) throw new Error(`route not registered: ${key}`);
  const res = makeRes();
  handler({ header: () => undefined, headers: {} }, res);
  for (let i = 0; i < 200 && !res.done; i++) await new Promise((r) => setTimeout(r, 5));
  if (!res.done) throw new Error(`route ${key} never responded`);
  return { status: res.statusCode, body: res.body };
}

/** Load a clients config through the real loader in a fresh module instance. */
async function loadFresh(path: string): Promise<{ state: ClientsLoadState; threw: unknown }> {
  vi.resetModules();
  const cfg = await import('../../src/gateway/config.js');
  let threw: unknown;
  try { cfg.loadClients(path); } catch (e) { threw = e; }
  return { state: cfg.clientsLoadState(), threw };
}

function writeConfig(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content);
  return path;
}

const VALID_CLIENTS = `clients:
  - id: client-a
    name: A
    keyHash: "${'a'.repeat(64)}"
    enabled: true
    scopes: [targets:read, files:read]
    targets: ["demo"]
`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcpb-ready-'));
  exitCodes = [];
  uncaught = [];
  h.executorReady.value = true;
  process.env.INTERNAL_TOKEN = 'test-internal-token';
  process.env.BRIDGE_PORT = '0';
  process.env.DATA_DIR = join(tmp, 'data');
  delete process.env.BRIDGE_PUBLIC_URL;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(Number(code ?? 0));
    return undefined as never;
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  process.off('uncaughtException', onUncaught);
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  delete process.env.CLIENTS_CONFIG;
});

// ---------------------------------------------------------------------------
// A/E/F — readiness with a loadable config
// ---------------------------------------------------------------------------

describe('gateway /readyz — config loaded', () => {
  it('A: valid clients config + executor ready → 200', async () => {
    process.env.CLIENTS_CONFIG = writeConfig('clients.yaml', VALID_CLIENTS);
    const state = await startGateway();
    expect(state).toEqual({ status: 'loaded', principalCount: 1 });
    expect(await callRoute('GET /readyz')).toEqual({ status: 200, body: { ok: true } });
    expect(exitCodes).toEqual([]);
    expect(uncaught).toEqual([]);
  });

  it('E: valid file with clients: [] → loaded, principalCount 0, and still ready', async () => {
    process.env.CLIENTS_CONFIG = writeConfig('empty.yaml', 'clients: []\n');
    const state = await startGateway();
    // The discriminant, asserted directly: an empty allowlist is NOT a failure.
    expect(state.status).toBe('loaded');
    expect(state).toEqual({ status: 'loaded', principalCount: 0 });
    expect(await callRoute('GET /readyz')).toEqual({ status: 200, body: { ok: true } });
  });

  it('F: executor unavailable with a valid config → 503 (unchanged behavior)', async () => {
    process.env.CLIENTS_CONFIG = writeConfig('clients.yaml', VALID_CLIENTS);
    h.executorReady.value = false;
    const state = await startGateway();
    expect(state.status).toBe('loaded');
    expect(await callRoute('GET /readyz')).toEqual({ status: 503, body: { ok: false } });
  });
});

// ---------------------------------------------------------------------------
// B/C/D — config load failures
// ---------------------------------------------------------------------------

describe('gateway /readyz — config load failure', () => {
  it('B: nonexistent CLIENTS_CONFIG path → not_found failure, 503, no leakage', async () => {
    const missing = join(tmp, 'does-not-exist', 'clients.yaml');
    process.env.CLIENTS_CONFIG = missing;
    const state = await startGateway();
    expect(state.status).toBe('failed');
    if (state.status !== 'failed') throw new Error('unreachable');
    expect(state.reason).toBe('not_found');
    expect(state.message).not.toContain(missing);
    expect(state.message).not.toContain(tmp);

    const res = await callRoute('GET /readyz');
    expect(res).toEqual({ status: 503, body: { ok: false } });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(missing);
    expect(serialized).not.toContain(tmp);
    expect(serialized).not.toContain('not_found');
    expect(uncaught).toEqual([]);
    expect(exitCodes).toEqual([]);
  });

  it('C: malformed YAML → parse_error failure, 503, no uncaught throw', async () => {
    process.env.CLIENTS_CONFIG = writeConfig('bad.yaml', 'clients:\n  - id: a\n   name: broken\n\t- nope\n');
    const state = await startGateway();
    expect(state.status).toBe('failed');
    if (state.status !== 'failed') throw new Error('unreachable');
    expect(state.reason).toBe('parse_error');
    expect(await callRoute('GET /readyz')).toEqual({ status: 503, body: { ok: false } });
    // Startup survived: liveness route registered, no exit, no uncaught error.
    expect(await callRoute('GET /healthz')).toEqual({ status: 200, body: { ok: true } });
    expect(uncaught).toEqual([]);
    expect(exitCodes).toEqual([]);
  });

  it('C2: unreadable config (directory, not a file) → read_error failure, distinct from not_found/parse_error, 503, no leakage', async () => {
    // The path exists (fs.existsSync is true) but fs.readFileSync fails before
    // YAML ever sees it — deterministic EISDIR, portable across environments
    // and independent of uid/gid (unlike EACCES/chmod).
    process.env.CLIENTS_CONFIG = tmp;
    const state = await startGateway();
    expect(state.status).toBe('failed');
    if (state.status !== 'failed') throw new Error('unreachable');
    expect(state.reason).toBe('read_error');
    expect(state.reason).not.toBe('not_found');
    expect(state.reason).not.toBe('parse_error');
    expect(state.message).not.toContain(tmp);

    // Fail-closed: no principals survive a read failure.
    const cfg = await import('../../src/gateway/config.js');
    expect(cfg.allPrincipals()).toEqual([]);

    const readyz = await callRoute('GET /readyz');
    expect(readyz).toEqual({ status: 503, body: { ok: false } });
    const serialized = JSON.stringify(readyz.body);
    expect(serialized).not.toContain(tmp);
    expect(serialized).not.toContain('read_error');

    // Liveness is unaffected by the readiness failure.
    expect(await callRoute('GET /healthz')).toEqual({ status: 200, body: { ok: true } });
    expect(uncaught).toEqual([]);
    expect(exitCodes).toEqual([]);
  });

  it('D: missing keyHash → schema_invalid failure, 503', async () => {
    process.env.CLIENTS_CONFIG = writeConfig('nokey.yaml', 'clients:\n  - id: client-a\n    name: A\n');
    const state = await startGateway();
    expect(state.status).toBe('failed');
    if (state.status !== 'failed') throw new Error('unreachable');
    expect(state.reason).toBe('schema_invalid');
    expect(await callRoute('GET /readyz')).toEqual({ status: 503, body: { ok: false } });
    expect(uncaught).toEqual([]);
  });

  it('D: duplicate client id → schema_invalid failure, 503', async () => {
    process.env.CLIENTS_CONFIG = writeConfig('dupe.yaml', `clients:
  - id: dup
    name: One
    keyHash: "${'a'.repeat(64)}"
  - id: dup
    name: Two
    keyHash: "${'b'.repeat(64)}"
`);
    const state = await startGateway();
    expect(state.status).toBe('failed');
    if (state.status !== 'failed') throw new Error('unreachable');
    expect(state.reason).toBe('schema_invalid');
    expect(await callRoute('GET /readyz')).toEqual({ status: 503, body: { ok: false } });
    expect(uncaught).toEqual([]);
  });

  it('G: /healthz stays 200 with a broken config present', async () => {
    for (const cfg of ['missing', 'malformed', 'invalid'] as const) {
      if (cfg === 'missing') process.env.CLIENTS_CONFIG = join(tmp, 'gone', 'clients.yaml');
      if (cfg === 'malformed') process.env.CLIENTS_CONFIG = writeConfig('g-bad.yaml', 'clients: [\n');
      if (cfg === 'invalid') process.env.CLIENTS_CONFIG = writeConfig('g-inv.yaml', 'clients:\n  - name: no-id\n');
      const state = await startGateway();
      expect(state.status, cfg).toBe('failed');
      expect(await callRoute('GET /healthz'), cfg).toEqual({ status: 200, body: { ok: true } });
      expect(await callRoute('GET /readyz'), cfg).toEqual({ status: 503, body: { ok: false } });
    }
    expect(uncaught).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Loader-level state model (no gateway startup involved)
// ---------------------------------------------------------------------------

describe('clients config load state model', () => {
  it('starts as not_loaded before any load', async () => {
    vi.resetModules();
    const cfg = await import('../../src/gateway/config.js');
    expect(cfg.clientsLoadState()).toEqual({ status: 'not_loaded' });
  });

  it('a valid file with principals records loaded with the principal count', async () => {
    const { state, threw } = await loadFresh(writeConfig('ok.yaml', VALID_CLIENTS));
    expect(threw).toBeUndefined();
    expect(state).toEqual({ status: 'loaded', principalCount: 1 });
  });

  it('a pre-A1 config without agent scopes still loads (backward compatibility)', async () => {
    const path = writeConfig('legacy.yaml', `clients:
  - id: legacy
    name: Legacy
    keyHash: "${'b'.repeat(64)}"
    enabled: true
    scopes: [targets:read, files:read, files:write, files:delete, terminal:exec, git:read, process:read]
    targets: ["*"]
`);
    vi.resetModules();
    const cfg = await import('../../src/gateway/config.js');
    cfg.loadClients(path);
    expect(cfg.clientsLoadState()).toEqual({ status: 'loaded', principalCount: 1 });
    const p = cfg.principalById('legacy');
    expect(p).toBeDefined();
    expect(cfg.principalHasScope(p!, 'files:write')).toBe(true);
    expect(cfg.principalHasScope(p!, 'agents:dispatch')).toBe(false);
    expect(p!.projects).toEqual([]);
  });

  it('a missing file is a failure, NOT an empty-but-valid config', async () => {
    const { state, threw } = await loadFresh(join(tmp, 'nope', 'clients.yaml'));
    expect(threw).toBeUndefined(); // missing file does not throw; it records
    expect(state).toEqual({ status: 'failed', reason: 'not_found', message: expect.any(String) });
  });

  it('an unreadable path (a directory, so fs.readFileSync fails, not fs.existsSync) is read_error, NOT not_found/parse_error', async () => {
    // loadClients throws here (unlike the not_found case): the caller (gateway
    // startup) is responsible for catching it, which the /readyz-facing test
    // above (C2) exercises end to end.
    const { state, threw } = await loadFresh(tmp);
    expect(threw).toBeInstanceOf(Error);
    expect(state.status).toBe('failed');
    if (state.status !== 'failed') throw new Error('unreachable');
    expect(state.reason).toBe('read_error');
    expect(state.reason).not.toBe('not_found');
    expect(state.reason).not.toBe('parse_error');
    expect(state.message).not.toContain(tmp);
  });

  it('load failures drop every principal (fail closed)', async () => {
    vi.resetModules();
    const cfg = await import('../../src/gateway/config.js');
    cfg.loadClients(writeConfig('good.yaml', VALID_CLIENTS));
    expect(cfg.allPrincipals()).toHaveLength(1);
    expect(() => cfg.loadClients(writeConfig('dupe2.yaml', `clients:
  - id: dup
    name: One
    keyHash: "${'a'.repeat(64)}"
  - id: dup
    name: Two
    keyHash: "${'b'.repeat(64)}"
`))).toThrow();
    expect(cfg.clientsLoadState().status).toBe('failed');
    expect(cfg.allPrincipals()).toEqual([]);
  });

  it('failure diagnostics never echo file content or key hashes', async () => {
    const secretHash = 'f'.repeat(64);
    const path = writeConfig('leaky.yaml', `clients:\n  - id: leaky\n     keyHash: "${secretHash}"\n\tbad: [\n`);
    const { state } = await loadFresh(path);
    expect(state.status).toBe('failed');
    if (state.status !== 'failed') throw new Error('unreachable');
    expect(state.message).not.toContain(secretHash);
    expect(state.message).not.toContain('leaky');
  });
});

// ---------------------------------------------------------------------------
// H — combinatorial config × executor readiness
// ---------------------------------------------------------------------------

describe('H: readiness matrix (config × executor)', () => {
  it('/readyz is 200 only when the config is loaded AND the executor is ready', async () => {
    const configs: Array<{ label: string; path: () => string; loaded: boolean }> = [
      { label: 'loaded', path: () => writeConfig('h-ok.yaml', VALID_CLIENTS), loaded: true },
      { label: 'not_found', path: () => join(tmp, 'h-missing', 'clients.yaml'), loaded: false },
      { label: 'parse_error', path: () => writeConfig('h-bad.yaml', 'clients: [\n'), loaded: false },
    ];
    for (const cfg of configs) {
      for (const executorReady of [true, false]) {
        process.env.CLIENTS_CONFIG = cfg.path();
        h.executorReady.value = executorReady;
        const state = await startGateway();
        expect(state.status, cfg.label).toBe(cfg.loaded ? 'loaded' : 'failed');
        const expected = cfg.loaded && executorReady ? 200 : 503;
        const res = await callRoute('GET /readyz');
        expect(res.status, `${cfg.label} × executorReady=${executorReady}`).toBe(expected);
        expect(res.body).toEqual({ ok: expected === 200 });
        // Liveness is never affected.
        expect(await callRoute('GET /healthz')).toEqual({ status: 200, body: { ok: true } });
      }
    }
    expect(uncaught).toEqual([]);
    expect(exitCodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// I/J/K — compose.yaml provenance + healthcheck (static assertions)
// ---------------------------------------------------------------------------

describe('compose.yaml healthcheck + image provenance', () => {
  const composePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'compose.yaml');
  const composeText = readFileSync(composePath, 'utf8');
  const compose = YAML.parse(composeText, { merge: true }) as {
    services: Record<string, { image: string; healthcheck?: { test: string[] } }>;
  };

  it('I: the gateway healthcheck probes /readyz, not /healthz', () => {
    const test = compose.services.gateway?.healthcheck?.test ?? [];
    const probe = test.join(' ');
    expect(probe).toContain('/readyz');
    expect(probe).not.toContain('/healthz');
    expect(probe).toContain('r.ok?0:1');
  });

  it('I: the executor healthcheck still probes /healthz (unchanged)', () => {
    const probe = (compose.services.executor?.healthcheck?.test ?? []).join(' ');
    expect(probe).toContain('/healthz');
    expect(probe).not.toContain('/readyz');
  });

  it('J: gateway and executor images use independent env-var references', () => {
    expect(compose.services.gateway?.image).toBe('${GATEWAY_IMAGE:-mcp-ide-bridge:latest}');
    expect(compose.services.executor?.image).toBe('${EXECUTOR_IMAGE:-mcp-ide-bridge:latest}');
    expect(compose.services.gateway?.image).not.toBe(compose.services.executor?.image);
  });

  it('K: the defaults equal the previous hardcoded tag, so unset env changes nothing', () => {
    for (const svc of ['gateway', 'executor'] as const) {
      const image = compose.services[svc]?.image ?? '';
      const match = /^\$\{[A-Z_]+:-(?<def>[^}]+)\}$/.exec(image);
      expect(match?.groups?.def, svc).toBe('mcp-ide-bridge:latest');
    }
  });

  it('no commit SHA is hardcoded in compose.yaml image references', () => {
    for (const svc of ['gateway', 'executor'] as const) {
      expect(compose.services[svc]?.image).not.toMatch(/[0-9a-f]{7,40}/);
    }
  });
});
