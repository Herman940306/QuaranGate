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
 *   EGRESS_PROXY_PORT             listen port (default 8080)
 *   EGRESS_PROXY_ALLOWLIST        optional comma-separated EXTRA hosts (trusted)
 *   EGRESS_PROXY_EXACT_ALLOWLIST  optional comma-separated REPLACEMENT allowlist
 *
 * The proxy never sees the Kiro API key, never mounts the project or /jobs, and
 * never receives docker.sock. TLS stays end-to-end (CONNECT passthrough).
 */
import { EgressProxy, parseEgressProxyEnvironment } from './egressProxy.js';

let proxy: EgressProxy;
try {
  proxy = new EgressProxy(parseEgressProxyEnvironment(process.env));
} catch (error) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'egress proxy configuration invalid', error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}

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
