import type express from 'express';

export class GatewayRequestAdmissionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'GatewayRequestAdmissionError';
  }
}

interface Authority {
  hostname: string;
  port: string;
  canonical: string;
}

export interface GatewayRequestPolicy {
  publicOrigin: string;
  /** Exact raw Host authorities accepted by the gateway. */
  allowedHosts: ReadonlySet<string>;
  /** Host -> exact browser Origin values permitted with that Host. */
  originsByHost: ReadonlyMap<string, ReadonlySet<string>>;
}

const DNS_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

function isIpv4(value: string): boolean {
  if (!IPV4.test(value)) return false;
  return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function isLoopbackHostname(value: string): boolean {
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

/** Parse an HTTP authority without trusting proxy-forwarded headers. */
export function parseRequestAuthority(raw: string): Authority {
  if (!raw || raw.length > 512 || /[\u0000-\u0020\u007f,/@\\?#]/u.test(raw)) {
    throw new GatewayRequestAdmissionError('HOST_INVALID', 'request Host authority is malformed');
  }

  let hostname: string;
  let port = '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end <= 1) throw new GatewayRequestAdmissionError('HOST_INVALID', 'request Host authority is malformed');
    hostname = raw.slice(1, end).toLowerCase();
    const suffix = raw.slice(end + 1);
    if (suffix) {
      if (!/^:\d{1,5}$/u.test(suffix)) throw new GatewayRequestAdmissionError('HOST_INVALID', 'request Host authority is malformed');
      port = suffix.slice(1);
    }
    // The gateway accepts only the IPv6 loopback literal; no zones or arbitrary
    // IPv6 literals are needed for its loopback/public-origin contract.
    if (hostname !== '::1') throw new GatewayRequestAdmissionError('HOST_INVALID', 'request IPv6 Host is not an approved loopback authority');
  } else {
    const colon = raw.lastIndexOf(':');
    if (colon !== -1) {
      if (raw.indexOf(':') !== colon) throw new GatewayRequestAdmissionError('HOST_INVALID', 'unbracketed IPv6 Host is not allowed');
      hostname = raw.slice(0, colon).toLowerCase();
      port = raw.slice(colon + 1);
      if (!/^\d{1,5}$/u.test(port)) throw new GatewayRequestAdmissionError('HOST_INVALID', 'request Host port is malformed');
    } else {
      hostname = raw.toLowerCase();
    }
    if (hostname.endsWith('.') || hostname.includes('..') || (!DNS_HOST.test(hostname) && !isIpv4(hostname))) {
      throw new GatewayRequestAdmissionError('HOST_INVALID', 'request Host name is malformed');
    }
  }

  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535 || String(n) !== port) {
      throw new GatewayRequestAdmissionError('HOST_INVALID', 'request Host port is outside the valid range');
    }
  }
  const hostPart = hostname.includes(':') ? `[${hostname}]` : hostname;
  return { hostname, port, canonical: port ? `${hostPart}:${port}` : hostPart };
}

function parsePublicOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayRequestAdmissionError('PUBLIC_ORIGIN_INVALID', 'BRIDGE_PUBLIC_URL must be an absolute HTTP(S) origin');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new GatewayRequestAdmissionError('PUBLIC_ORIGIN_INVALID', 'BRIDGE_PUBLIC_URL must be an origin only');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (url.protocol === 'http:' && !isLoopbackHostname(hostname)) {
    throw new GatewayRequestAdmissionError('PUBLIC_ORIGIN_INSECURE', 'non-loopback BRIDGE_PUBLIC_URL must use HTTPS');
  }
  // Apply the same strict host grammar to the configured origin. Explicit
  // default ports are normalized by URL, so reconstruct through url.host.
  parseRequestAuthority(url.host);
  return url;
}

function addHostOrigin(
  hosts: Set<string>,
  originsByHost: Map<string, Set<string>>,
  host: string,
  origin: string,
): void {
  const canonical = parseRequestAuthority(host).canonical;
  hosts.add(canonical);
  const origins = originsByHost.get(canonical) ?? new Set<string>();
  origins.add(origin);
  originsByHost.set(canonical, origins);
}

function withExplicitDefaultPort(url: URL): string | null {
  if (url.port) return null;
  const port = url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
  if (!port) return null;
  const hostname = url.hostname.includes(':') ? `[${url.hostname.replace(/^\[|\]$/gu, '')}]` : url.hostname;
  return `${hostname.toLowerCase()}:${port}`;
}

export function buildGatewayRequestPolicy(publicUrl: string, gatewayPort: number): GatewayRequestPolicy {
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
    throw new GatewayRequestAdmissionError('GATEWAY_PORT_INVALID', 'BRIDGE_PORT must be an integer from 1 through 65535');
  }
  const publicOriginUrl = parsePublicOrigin(publicUrl);
  const publicOrigin = publicOriginUrl.origin;
  const hosts = new Set<string>();
  const originsByHost = new Map<string, Set<string>>();

  addHostOrigin(hosts, originsByHost, publicOriginUrl.host, publicOrigin);
  const explicitDefault = withExplicitDefaultPort(publicOriginUrl);
  if (explicitDefault) addHostOrigin(hosts, originsByHost, explicitDefault, publicOrigin);

  for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
    const authority = `${hostname}:${gatewayPort}`;
    addHostOrigin(hosts, originsByHost, authority, `http://${authority}`);
    // Approved reverse proxies (for example the existing HTTPS Funnel ->
    // loopback target) may rewrite Host to the upstream loopback authority.
    // The public Origin is still operator-pinned and therefore remains valid
    // with that exact approved loopback Host. Forwarded headers are not trusted.
    addHostOrigin(hosts, originsByHost, authority, publicOrigin);
  }

  return { publicOrigin, allowedHosts: hosts, originsByHost };
}

function parseOrigin(raw: string): string {
  if (!raw || raw === 'null' || raw.length > 2048 || /[\u0000-\u001f\u007f,]/u.test(raw)) {
    throw new GatewayRequestAdmissionError('ORIGIN_INVALID', 'request Origin is malformed');
  }
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new GatewayRequestAdmissionError('ORIGIN_INVALID', 'request Origin is malformed');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new GatewayRequestAdmissionError('ORIGIN_INVALID', 'request Origin is not an HTTP(S) origin');
  }
  parseRequestAuthority(url.host);
  return url.origin;
}

function rawHeaderCount(rawHeaders: readonly string[] | undefined, name: string): number {
  if (!rawHeaders) return 0;
  let count = 0;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

export function gatewayRequestAdmission(policy: GatewayRequestPolicy): express.RequestHandler {
  return (req, res, next) => {
    try {
      // Real Node HTTP requests expose rawHeaders. Require exactly one Host so
      // duplicate-header normalization cannot turn a smuggling attempt into an
      // apparently valid authority. Test recorders that do not model rawHeaders
      // are still governed by the normalized header checks below.
      if (req.rawHeaders && rawHeaderCount(req.rawHeaders, 'host') !== 1) {
        throw new GatewayRequestAdmissionError('HOST_DUPLICATE', 'request must contain exactly one Host header');
      }
      if (req.rawHeaders && rawHeaderCount(req.rawHeaders, 'origin') > 1) {
        throw new GatewayRequestAdmissionError('ORIGIN_DUPLICATE', 'request must not contain multiple Origin headers');
      }
      // Deliberately inspect the raw Host header. X-Forwarded-Host/Forwarded are
      // untrusted metadata and never participate in this decision.
      const rawHost = req.headers.host;
      if (typeof rawHost !== 'string') {
        throw new GatewayRequestAdmissionError('HOST_MISSING', 'request Host is required');
      }
      const host = parseRequestAuthority(rawHost).canonical;
      if (!policy.allowedHosts.has(host)) {
        throw new GatewayRequestAdmissionError('HOST_DENIED', 'request Host is not an approved gateway authority');
      }

      const rawOrigin = req.headers.origin;
      if (rawOrigin !== undefined) {
        if (typeof rawOrigin !== 'string') {
          throw new GatewayRequestAdmissionError('ORIGIN_INVALID', 'request Origin is malformed');
        }
        const origin = parseOrigin(rawOrigin);
        if (!policy.originsByHost.get(host)?.has(origin)) {
          throw new GatewayRequestAdmissionError('ORIGIN_DENIED', 'request Origin does not match the approved Host authority');
        }
      }
      next();
    } catch (error) {
      const admission = error instanceof GatewayRequestAdmissionError
        ? error
        : new GatewayRequestAdmissionError('REQUEST_AUTHORITY_INVALID', 'request authority validation failed');
      res.setHeader('Cache-Control', 'no-store');
      // 421 is appropriate for a Host/authority mismatch. Origin failures are
      // authorization failures and intentionally disclose no allowlist detail.
      const originFailure = admission.code.startsWith('ORIGIN_');
      res.status(originFailure ? 403 : 421).json({
        error: originFailure ? 'request origin rejected' : 'request authority rejected',
      });
    }
  };
}
