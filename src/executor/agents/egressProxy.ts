/**
 * Egress proxy for Kiro ACP runner — Phase A4.
 *
 * A minimal HTTP CONNECT proxy that enforces allowlist-based egress for
 * the Kiro runner container. The runner cannot make direct Internet
 * connections; it MUST go through this proxy, which only permits connections
 * to approved Kiro provider hosts on port 443.
 *
 * Architecture:
 *   Runner container (job-scoped network)
 *     → HTTP CONNECT to this proxy (bridge-controlled)
 *       → DNS resolution in the proxy (trusted)
 *         → Validated destination (allowlisted hostname, port 443, non-private IP)
 *           → TLS passthrough (no interception)
 *
 * Security invariants:
 *   - Strict hostname allowlist (exact match, no wildcards unless explicitly listed)
 *   - Only port 443 permitted
 *   - IP literals rejected
 *   - Private/internal/loopback/link-local addresses rejected (post-DNS)
 *   - Metadata endpoints (169.254.169.254) rejected
 *   - Docker internal addresses rejected
 *   - No TLS interception (end-to-end between runner and Kiro service)
 *   - No Authorization header logging
 *   - No project source passes through the proxy
 *   - No credential passes through the proxy (key is in runner env, not proxy)
 *   - Bounded connection lifetime
 *   - Proxy does NOT receive docker.sock
 */
import net from 'node:net';
import dns from 'node:dns/promises';
import { BridgeError } from '../../shared/errors.js';
import { isUnsafeEgressAddress, normalizeExactEgressHostname } from '../../shared/egressPolicy.js';
import { SANDBOX_LABEL_NS } from './sandboxSpec.js';

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Kiro provider endpoints — the ONLY destinations the runner may reach. These
 * are the endpoints extracted from the kiro-cli 2.5.0 binary and validated live
 * (see the a4-kiro-acp-runtime-facts audit note), NOT guesses. The optional
 * telemetry host `client-telemetry.us-east-1.amazonaws.com` is deliberately
 * OMITTED: it is non-fatal when blocked and must not be allowlisted.
 */
export const KIRO_PROVIDER_ALLOWLIST: readonly string[] = [
  // Kiro Runtime Service (KRS) — primary model/ACP backend (paid inference).
  'runtime.us-east-1.kiro.dev',
  'runtime.eu-central-1.kiro.dev',
  // Kiro auth (desktop/API-key exchange).
  'prod.us-east-1.auth.desktop.kiro.dev',
  // AWS Cognito Identity — the headless KIRO_API_KEY credential exchange hits
  // this endpoint at startup (confirmed by proxy egress logs: without it,
  // kiro-cli reports "not logged in"). It is part of Kiro's auth mechanism.
  'cognito-identity.us-east-1.amazonaws.com',
  // AWS OIDC token endpoint (region-scoped).
  'oidc.us-east-1.amazonaws.com',
  // AWS CodeWhisperer / Q backend (ACP startup + auth).
  'codewhisperer.us-east-1.amazonaws.com',
  // Amazon Q inference backend — REQUIRED for session/prompt model inference.
  // Proven by egress logs: without it, a real turn fails with ACP -32603
  // "Internal error" (the model call is denied). This is the paid-inference
  // destination, not telemetry. The related update host
  // `desktop-release.q.us-east-1.amazonaws.com` is deliberately NOT allowlisted.
  'q.us-east-1.amazonaws.com',
];

/** Only port 443 is permitted. */
const ALLOWED_PORT = 443;

/** Maximum connection lifetime (10 minutes — generous for a single LLM turn). */
const MAX_CONNECTION_LIFETIME_MS = 10 * 60 * 1000;

/** Maximum concurrent connections per proxy instance. */
const MAX_CONCURRENT_CONNECTIONS = 32;
const MAX_CONNECT_HEADER_BYTES = 8 * 1024;
const MAX_EARLY_TUNNEL_BYTES = 64 * 1024;
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Private address detection
// ---------------------------------------------------------------------------

/**
 * Check if an IP address is private, internal, loopback, link-local,
 * or otherwise unsafe for egress.
 */
export function isPrivateAddress(ip: string): boolean {
  return isUnsafeEgressAddress(ip);
}

/**
 * Validate a CONNECT target hostname. Returns an error message if invalid, or null if OK.
 */
export function validateConnectTarget(
  host: string,
  port: number,
  allowedHosts: ReadonlySet<string> | readonly string[] = KIRO_PROVIDER_ALLOWLIST,
): string | null {
  if (port !== ALLOWED_PORT) {
    return `port ${port} not allowed; only ${ALLOWED_PORT} is permitted`;
  }
  if (net.isIP(host)) return 'IP literals are not allowed; use hostnames';
  if (host.includes('@')) return 'userinfo in host is not allowed';
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return 'localhost connections are not allowed';
  let normalized: string;
  try { normalized = normalizeExactEgressHostname(host); }
  catch { return 'hostname is malformed or not an exact Internet hostname'; }
  const normalizedAllowed = new Set(Array.from(allowedHosts, (value) => {
    try { return normalizeExactEgressHostname(value); }
    catch { return ''; }
  }).filter(Boolean));
  if (!normalizedAllowed.has(normalized)) return `host "${normalized}" is not in the egress allowlist`;
  return null;
}

/**
 * Resolve a hostname and validate all returned addresses are non-private.
 * DNS resolution happens in the trusted proxy, not in the untrusted runner.
 */
export type EgressLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const DEFAULT_DNS_TIMEOUT_MS = 5_000;

async function defaultLookup(host: string): Promise<Array<{ address: string; family: number }>> {
  return dns.lookup(host, { all: true, verbatim: true });
}

export async function resolveAndValidate(
  host: string,
  lookup: EgressLookup = defaultLookup,
  timeoutMs = DEFAULT_DNS_TIMEOUT_MS,
): Promise<string> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new BridgeError('SANDBOX_FAILED', 'egress proxy: DNS timeout policy is invalid', 500);
  }
  let timer: NodeJS.Timeout | undefined;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await Promise.race([
      lookup(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BridgeError('SANDBOX_FAILED', `egress proxy: DNS resolution timed out for ${host}`, 502)), timeoutMs);
      }),
    ]);
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError('SANDBOX_FAILED',
      `egress proxy: DNS resolution failed for ${host}: ${(e as Error).message}`, 502);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new BridgeError('SANDBOX_FAILED', `egress proxy: no addresses for ${host}`, 502);
  }
  for (const addr of addresses) {
    const family = net.isIP(addr?.address ?? '');
    if ((family !== 4 && family !== 6) || addr.family !== family) {
      throw new BridgeError('SANDBOX_FAILED', `egress proxy: ${host} returned malformed DNS address data`, 502);
    }
    if (isUnsafeEgressAddress(addr.address)) {
      throw new BridgeError('SANDBOX_FAILED',
        `egress proxy: ${host} resolved to non-global address (blocked)`, 403);
    }
  }
  return addresses[0]!.address;
}

// ---------------------------------------------------------------------------
// Proxy Server
// ---------------------------------------------------------------------------

export interface EgressProxyEnvironment {
  EGRESS_PROXY_PORT?: string;
  EGRESS_PROXY_ALLOWLIST?: string;
  EGRESS_PROXY_EXACT_ALLOWLIST?: string;
}

function parseHostList(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean).map(normalizeExactEgressHostname);
  return [...new Set(values)];
}

export function parseEgressProxyEnvironment(env: EgressProxyEnvironment): EgressProxyOptions {
  const rawPort = env.EGRESS_PROXY_PORT ?? '8080';
  if (!/^[0-9]{1,5}$/u.test(rawPort)) throw new Error('EGRESS_PROXY_PORT must be an integer 1..65535');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('EGRESS_PROXY_PORT must be an integer 1..65535');
  const hasExact = Object.prototype.hasOwnProperty.call(env, 'EGRESS_PROXY_EXACT_ALLOWLIST');
  const exact = parseHostList(env.EGRESS_PROXY_EXACT_ALLOWLIST);
  const extra = parseHostList(env.EGRESS_PROXY_ALLOWLIST);
  if (hasExact && exact.length === 0) throw new Error('EGRESS_PROXY_EXACT_ALLOWLIST was provided but contains no valid hosts');
  if (hasExact && extra.length > 0) throw new Error('exact and additive egress allowlists cannot be combined');
  return {
    listenHost: '0.0.0.0',
    listenPort: port,
    ...(hasExact ? { allowedHosts: exact } : {}),
    ...(!hasExact && extra.length > 0 ? { additionalHosts: extra } : {}),
  };
}

export interface EgressProxyOptions {
  /** Listen address (should be on the job-scoped Docker network). */
  listenHost?: string;
  /** Listen port. */
  listenPort?: number;
  /** Additional allowed hosts beyond the default Kiro list. */
  additionalHosts?: string[];
  /** Exact replacement allowlist for a dedicated proxy trust domain. */
  allowedHosts?: string[];
}

export class EgressProxy {
  private server: net.Server | null = null;
  private connections = new Set<net.Socket>();
  private allowlist: Set<string>;
  private closed = false;

  constructor(private readonly opts: EgressProxyOptions = {}) {
    const selected = opts.allowedHosts !== undefined
      ? [...opts.allowedHosts]
      : [...KIRO_PROVIDER_ALLOWLIST, ...(opts.additionalHosts ?? [])];
    this.allowlist = new Set(selected.map(normalizeExactEgressHostname));
  }

  /** Start the proxy server. Returns the actual listen address. */
  async start(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((clientSocket) => {
        this.handleConnection(clientSocket);
      });

      const host = this.opts.listenHost ?? '0.0.0.0';
      const port = this.opts.listenPort ?? 0;

      this.server.on('error', reject);
      this.server.listen(port, host, () => {
        const addr = this.server!.address() as net.AddressInfo;
        resolve({ host: addr.address, port: addr.port });
      });
    });
  }

  /** Stop the proxy, closing all active connections. */
  async stop(): Promise<void> {
    this.closed = true;
    for (const sock of this.connections) {
      sock.destroy();
    }
    this.connections.clear();
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
    });
  }

  private log(msg: string, fields: Record<string, unknown>): void {
    // Structured egress audit. NEVER logs Authorization or credential material
    // (CONNECT requests carry none, and the TLS body is never inspected).
    console.log(JSON.stringify({ level: 'info', component: 'egress-proxy', msg, ...fields }));
  }

  private handleConnection(clientSocket: net.Socket): void {
    if (this.closed) { clientSocket.destroy(); return; }
    if (this.connections.size >= MAX_CONCURRENT_CONNECTIONS) {
      clientSocket.end('HTTP/1.1 503 Too Many Connections\r\n\r\n');
      return;
    }

    this.connections.add(clientSocket);
    clientSocket.on('close', () => this.connections.delete(clientSocket));

    const lifeTimer = setTimeout(() => clientSocket.destroy(), MAX_CONNECTION_LIFETIME_MS);
    clientSocket.on('close', () => clearTimeout(lifeTimer));

    let pending = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      const combined = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const headerEnd = combined.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (combined.length > MAX_CONNECT_HEADER_BYTES) {
          clientSocket.removeListener('data', onData);
          clientSocket.end('HTTP/1.1 400 Request Too Large\r\n\r\n');
          return;
        }
        pending = Buffer.from(combined);
        return;
      }
      if (headerEnd + 4 > MAX_CONNECT_HEADER_BYTES) {
        clientSocket.removeListener('data', onData);
        clientSocket.end('HTTP/1.1 400 Request Too Large\r\n\r\n');
        return;
      }
      const earlyData = combined.subarray(headerEnd + 4);
      if (earlyData.length > MAX_EARLY_TUNNEL_BYTES) {
        clientSocket.removeListener('data', onData);
        clientSocket.end('HTTP/1.1 400 Early Tunnel Data Too Large\r\n\r\n');
        return;
      }
      clientSocket.removeListener('data', onData);
      clientSocket.pause();
      const header = combined.subarray(0, headerEnd).toString('utf8');
      void this.handleConnect(clientSocket, header, earlyData);
    };

    clientSocket.on('data', onData);
    clientSocket.on('error', () => { clientSocket.destroy(); });
  }

  private async handleConnect(clientSocket: net.Socket, header: string, earlyData: Buffer): Promise<void> {
    // Parse CONNECT request.
    const firstLine = header.split('\r\n')[0] ?? '';
    const match = firstLine.match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\/1\.[01]$/i);
    if (!match) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    const host = match[1]!.toLowerCase();
    const port = parseInt(match[2]!, 10);

    // Validate against allowlist and port policy. Log the decision (host + port
    // only — NEVER any Authorization/credential material) for egress audit.
    const validationError = validateConnectTarget(host, port, this.allowlist);
    if (validationError) {
      this.log('egress denied', { host, port, reason: validationError });
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nX-Proxy-Error: ${validationError}\r\n\r\n`);
      return;
    }
    this.log('egress allowed', { host, port });

    // Resolve DNS in the trusted proxy and validate resolved addresses.
    let resolvedIp: string;
    try {
      resolvedIp = await resolveAndValidate(host);
    } catch {
      clientSocket.end('HTTP/1.1 502 DNS Resolution Failed\r\n\r\n');
      return;
    }

    // Connect to the validated pinned address; never resolve the hostname again.
    const upstream = net.connect({ host: resolvedIp, port });
    let established = false;
    const connectTimer = setTimeout(() => {
      if (established) return;
      upstream.destroy();
      clientSocket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    upstream.once('connect', () => {
      established = true;
      clearTimeout(connectTimer);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (earlyData.length > 0) upstream.write(earlyData);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      clientSocket.resume();
    });

    upstream.on('error', () => {
      clearTimeout(connectTimer);
      if (!established) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      upstream.destroy();
    });

    clientSocket.on('close', () => {
      upstream.destroy();
    });

    upstream.on('close', () => {
      clearTimeout(connectTimer);
      clientSocket.destroy();
    });
  }
}

// ---------------------------------------------------------------------------
// Docker network helper for job-scoped isolation.
// ---------------------------------------------------------------------------

/**
 * Network name for a job-scoped backend-only network.
 * The runner and proxy are the ONLY containers on this network.
 */
export function jobNetworkName(jobId: string): string {
  return `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-net-${jobId}`;
}
