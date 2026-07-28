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

// ---------------------------------------------------------------------------
// Private address detection
// ---------------------------------------------------------------------------

/**
 * Check if an IP address is private, internal, loopback, link-local,
 * or otherwise unsafe for egress.
 */
export function isPrivateAddress(ip: string): boolean {
  // IPv4 checks
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    const [a, b] = parts;
    // Loopback: 127.0.0.0/8
    if (a === 127) return true;
    // Private: 10.0.0.0/8
    if (a === 10) return true;
    // Private: 172.16.0.0/12
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    // Private: 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // Link-local: 169.254.0.0/16 (includes the 169.254.169.254 metadata endpoint)
    if (a === 169 && b === 254) return true;
    // Carrier-grade NAT: 100.64.0.0/10 (defense in depth)
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
    // Unspecified 0.0.0.0/8 and broadcast 255.255.255.255
    if (a === 0) return true;
    if (a === 255) return true;
    // Docker default bridge 172.17.0.0/16 is already covered by 172.16-31.
    return false;
  }

  const lower = ip.toLowerCase();

  // IPv4-mapped / -embedded IPv6 (e.g. ::ffff:127.0.0.1, ::ffff:10.0.0.1,
  // 64:ff9b::a.b.c.d): if a dotted-quad is embedded, validate it as IPv4. This
  // closes the mapped-address bypass of the checks above.
  const mapped = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    return isPrivateAddress(mapped[1]!);
  }

  // Loopback: ::1
  if (lower === '::1' || lower === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  // Unspecified: ::
  if (lower === '::' || lower === '0000:0000:0000:0000:0000:0000:0000:0000') return true;
  // Link-local: fe80::/10
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // Unique local: fc00::/7
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;

  return false;
}

/**
 * Validate a CONNECT target hostname. Returns an error message if invalid, or null if OK.
 */
export function validateConnectTarget(host: string, port: number): string | null {
  // Port must be 443.
  if (port !== ALLOWED_PORT) {
    return `port ${port} not allowed; only ${ALLOWED_PORT} is permitted`;
  }

  // Reject IP literals (both IPv4 and IPv6).
  if (net.isIP(host)) {
    return 'IP literals are not allowed; use hostnames';
  }

  // Reject userinfo in the host.
  if (host.includes('@')) {
    return 'userinfo in host is not allowed';
  }

  // Reject localhost variants.
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return 'localhost connections are not allowed';
  }

  // Check allowlist (exact match).
  if (!KIRO_PROVIDER_ALLOWLIST.includes(lower)) {
    return `host "${lower}" is not in the egress allowlist`;
  }

  return null;
}

/**
 * Resolve a hostname and validate all returned addresses are non-private.
 * DNS resolution happens in the trusted proxy, not in the untrusted runner.
 */
export async function resolveAndValidate(host: string): Promise<string> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new BridgeError('SANDBOX_FAILED',
      `egress proxy: DNS resolution failed for ${host}: ${(e as Error).message}`, 502);
  }

  if (addresses.length === 0) {
    throw new BridgeError('SANDBOX_FAILED', `egress proxy: no addresses for ${host}`, 502);
  }

  // Validate ALL resolved addresses are non-private.
  for (const addr of addresses) {
    if (isPrivateAddress(addr.address)) {
      throw new BridgeError('SANDBOX_FAILED',
        `egress proxy: ${host} resolved to private address (blocked)`, 403);
    }
  }

  // Return the first valid address.
  return addresses[0]!.address;
}

// ---------------------------------------------------------------------------
// Proxy Server
// ---------------------------------------------------------------------------

export interface EgressProxyOptions {
  /** Listen address (should be on the job-scoped Docker network). */
  listenHost?: string;
  /** Listen port. */
  listenPort?: number;
  /** Additional allowed hosts beyond the default list. */
  additionalHosts?: string[];
}

export class EgressProxy {
  private server: net.Server | null = null;
  private connections = new Set<net.Socket>();
  private allowlist: Set<string>;
  private closed = false;

  constructor(private readonly opts: EgressProxyOptions = {}) {
    this.allowlist = new Set([
      ...KIRO_PROVIDER_ALLOWLIST,
      ...(opts.additionalHosts ?? []),
    ]);
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

    // Set connection lifetime limit.
    const lifeTimer = setTimeout(() => {
      clientSocket.destroy();
    }, MAX_CONNECTION_LIFETIME_MS);
    clientSocket.on('close', () => clearTimeout(lifeTimer));

    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');

      // Look for the end of the CONNECT request headers.
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        // Bound the buffer to prevent memory attacks.
        if (buffer.length > 8192) {
          clientSocket.end('HTTP/1.1 400 Request Too Large\r\n\r\n');
        }
        return;
      }

      clientSocket.removeListener('data', onData);
      const header = buffer.slice(0, headerEnd);
      this.handleConnect(clientSocket, header);
    };

    clientSocket.on('data', onData);
    clientSocket.on('error', () => { clientSocket.destroy(); });
  }

  private async handleConnect(clientSocket: net.Socket, header: string): Promise<void> {
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
    const validationError = validateConnectTarget(host, port);
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

    // Connect to the resolved address.
    const upstream = net.connect({ host: resolvedIp, port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Bidirectional pipe: TLS passthrough, no interception.
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on('error', () => {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });

    clientSocket.on('error', () => {
      upstream.destroy();
    });

    clientSocket.on('close', () => {
      upstream.destroy();
    });

    upstream.on('close', () => {
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
