# Operations

All commands run from the repo root. The bridge stack is `compose.yaml`; the disposable demo target
is `test-target/compose.yaml`.

## Prerequisites

```bash
cp .env.example .env
# INTERNAL_TOKEN: openssl rand -base64 32
# DOCKER_GID:     stat -c %g /var/run/docker.sock
cp config/bridge.example.yaml  config/bridge.yaml
cp config/clients.example.yaml config/clients.yaml
npm install
npm run validate-config           # sanity-check config before starting
```

## Build / start / stop / restart

```bash
docker compose build
docker compose up -d
docker compose restart gateway
docker compose down                       # stop (keeps the bridge-data volume)
docker compose down -v                    # stop + remove the bridge-data volume
```

Disposable demo target:

```bash
docker compose -f test-target/compose.yaml up -d --build
docker compose -f test-target/compose.yaml down -v
```

## Health / readiness

```bash
curl -s http://127.0.0.1:8787/healthz     # gateway liveness
curl -s http://127.0.0.1:8787/readyz      # gateway + executor + docker reachable
docker compose ps
```

## Logs (structured JSON audit, redacted)

```bash
docker compose logs -f gateway            # audit entries: principal, tool, target, decision, duration
docker compose logs -f executor
```

Audit entries never contain API keys, tokens, headers, or file contents. Command arguments are
redacted best-effort (`src/shared/redact.ts`).

## Credential lifecycle

```bash
# Create / rotate: generate a key, then paste the printed keyHash into config/clients.yaml
npm run gen-key -- vscode
# Rotation = new key for the same client id, replace its keyHash, reload.

# Revoke (disable): keys/tokens for that client are rejected
npm run revoke-key -- vscode              # sets enabled: false
npm run revoke-key -- vscode --remove     # deletes the client entry

# Apply config changes without a full restart:
docker compose restart gateway            # reload clients.yaml (gateway)
# reload targets in the executor:
TOKEN=$(grep INTERNAL_TOKEN .env | cut -d= -f2-)
docker compose exec executor node -e "fetch('http://127.0.0.1:8990/reload',{method:'POST',headers:{'x-internal-token':process.env.INTERNAL_TOKEN}}).then(r=>console.log(r.status))"
```

Rotating `INTERNAL_TOKEN` requires restarting both services (`docker compose up -d`).

## Inspect discovered / configured targets

```bash
API_KEY=<a client key> ./scripts/mcp-check.sh          # protocol smoke test
# or list targets via the MCP tool:
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp \
  --transport http --header "Authorization: Bearer <key>" \
  --method tools/call --tool-name targets_list
```

## Run tests

```bash
npm test                                   # unit tests (no Docker needed)
# integration tests (need the stack + demo target up, and the generated keys):
KEYS_ENV=/path/to/keys.env npm run test:integration
```

## Remote ingress (NOT enabled — gated operator action)

Browser clients (Claude/ChatGPT) need a public **HTTPS** URL. The bridge is ingress-ready but binds
to `127.0.0.1` only and creates no tunnel. Enabling public exposure is a deliberate action with real
risk (see `docs/SECURITY.md`) and, in this project's operating rules, **requires explicit approval**.

Template options (none active):

- **Cloudflare Tunnel:** `cloudflared tunnel --url http://127.0.0.1:8787` → set
  `BRIDGE_PUBLIC_URL=https://<assigned-host>` in `.env`, rebuild gateway so OAuth metadata is correct.
- **Tailscale Funnel / Caddy / nginx:** terminate TLS, reverse-proxy to `127.0.0.1:8787`, forward the
  `Authorization` header untouched, set `BRIDGE_PUBLIC_URL` accordingly.

Whatever the front door: keep TLS verification on, do not expose the executor, and prefer a firewall
allowlist (e.g. Anthropic IP ranges for Claude).

## Backups / state

The only persistent state is the `mcp-bridge-data` volume (hashed OAuth tokens). It is safe to drop;
clients simply re-authorize. Config lives in `config/*.yaml` (gitignored) and `.env`.
