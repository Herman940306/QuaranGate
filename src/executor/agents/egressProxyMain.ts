/**
 * Egress proxy container entrypoint — Phase A4.
 *
 * Runs the SAME unit-tested `EgressProxy` (allowlist CONNECT proxy) inside a
 * trusted container attached to the job's internal + external networks, so the
 * no-NAT runner can reach ONLY the allowlisted Kiro endpoints through it.
 *
 * Depends solely on Node builtins + this repo's dist tree — no node_modules — so
 * it launches with `node dist/executor/agents/egressProxyMain.js`.
 *
 * Env:
 *   EGRESS_PROXY_PORT        listen port (default 8080)
 *   EGRESS_PROXY_ALLOWLIST   optional comma-separated EXTRA hosts (trusted)
 *
 * The proxy never sees the Kiro API key, never mounts the project or /jobs, and
 * never receives docker.sock. TLS stays end-to-end (CONNECT passthrough).
 */
import { EgressProxy } from './egressProxy.js';

const port = Number(process.env.EGRESS_PROXY_PORT ?? 8080);
const extra = (process.env.EGRESS_PROXY_ALLOWLIST ?? '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const proxy = new EgressProxy({ listenHost: '0.0.0.0', listenPort: port, additionalHosts: extra });

proxy.start()
  .then((addr) => {
    console.log(JSON.stringify({ level: 'info', msg: 'egress proxy listening', host: addr.host, port: addr.port }));
  })
  .catch((e) => {
    console.error(JSON.stringify({ level: 'fatal', msg: 'egress proxy failed to start', error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  });

function shutdown(): void { void proxy.stop().finally(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
