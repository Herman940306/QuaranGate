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
docker compose down                       # stop (keeps the quarangate-data volume)
docker compose down -v                    # stop + remove the quarangate-data volume
```

Disposable demo target:

```bash
docker compose -f test-target/compose.yaml up -d --build
docker compose -f test-target/compose.yaml down -v
```

## Image provenance

Production gateway and executor image references must be immutable and service-specific:
`quarangate:gateway-<sha>` and `quarangate:executor-<sha>`. Both services build from the same
Dockerfile/context and are tagged independently; `compose.yaml` selects them via `GATEWAY_IMAGE` and
`EXECUTOR_IMAGE`. `quarangate:latest` is the unset default and a dev convenience only — it is
never authoritative for production provenance. (The pre-existing `agentcontrol:*` candidate image
family — e.g. `agentcontrol:gateway-candidate-f37ff70` — and the `mcp-ide-bridge:*` family are
preserved as historical/rollback evidence and are not part of this convention; see
`MCP_IDE_BRIDGE_MASTER_PRD.md` §47 for the full identity migration contract.)

Build with provenance, then deploy the exact immutable tags.

**Deployment configuration lives in the deployment directory's `.env` — never in
one-off inline or exported shell variables.** A value that exists only in the
shell that happened to run `docker compose up` does not survive a fresh shell, a
restart, or a move to another checkout: Compose silently falls back to the
`:-` defaults in `compose.yaml`, so the stack comes back up as
`quarangate:latest` with `GIT_REVISION=unknown` and — because every `AGENT_*`
default is empty — with the real Kiro backend **disabled** (fake-only). That
regression is silent; nothing fails loudly. Pin it in `.env` instead.

### 1. Build the immutable images

```bash
SHA=$(git rev-parse HEAD)
docker build --build-arg GIT_REVISION="$SHA" -t "quarangate:gateway-$SHA" .
docker build --build-arg GIT_REVISION="$SHA" -t "quarangate:executor-$SHA" .
```

### 2. Pin the deployment in `.env`

`.env` is gitignored and untracked; it holds non-secret configuration only. The
Kiro API key itself stays in a single host file and reaches the executor solely
through the Compose `kiro_api_key` secret — `.env` names the FILE, never the
value (see "Secrets" below).

```dotenv
GIT_REVISION=<full reviewed commit sha>
GATEWAY_IMAGE=quarangate:gateway-<full reviewed commit sha>
EXECUTOR_IMAGE=quarangate:executor-<full reviewed commit sha>

AGENT_RUNNER_IMAGE=mcp-ide-bridge-kiro-runner:a4
AGENT_PROXY_IMAGE=quarangate:executor-<full reviewed commit sha>
AGENT_KIRO_KEY_PATH=/run/secrets/kiro-api-key
AGENT_KIRO_KEY_FILE=/home/herman/.config/quarangate/kiro-api-key
AGENT_KIRO_DRY_RUN=false
```

`AGENT_KIRO_DRY_RUN` is parsed as `/^(1|true|yes)$/i` (`src/executor/index.ts`),
so `false` is the explicit canonical non-dry-run value. State it rather than
leaving it empty. If the key file has not yet moved to the QuaranGate path,
resolve it new-path-first with `node scripts/resolve-kiro-key-file.mjs` and
write the result into `.env`.

### 3. Verify the resolved configuration from a FRESH shell

The point of this step is to prove nothing depends on the current shell, so run
it in a shell that has exported none of these variables:

```bash
docker compose config | grep -E 'image:|GIT_REVISION|AGENT_'
```

Every value must be the intended one — no empty `AGENT_*`, no
`quarangate:latest`, no `GIT_REVISION: unknown`.

> **`docker compose config` prints `INTERNAL_TOKEN` in cleartext** (once per
> service) because it is passed as a plain environment variable. Always filter
> its output as above rather than paging the whole document, and never paste
> unfiltered `docker compose config` output into a log, ticket, or review.
> The Kiro API key is *not* exposed this way: it is a Compose **secret**, so
> only its host FILE PATH appears — verify it with
> `docker compose config | grep -A1 'kiro_api_key'`.

### 4. Deploy

```bash
docker compose up -d
```

Every production build candidate must carry the commit it was built from, applied at build time
(never baked into source) via the `GIT_REVISION` build arg:

```text
org.opencontainers.image.revision=<exact commit SHA>
org.opencontainers.image.source=https://github.com/Herman940306/QuaranGate
```

Verify provenance on the built image before deploying:

```bash
docker image inspect quarangate:gateway-$SHA \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

The OAuth data volume (`quarangate-data`) has a lifecycle separate from the image lifecycle.
Replacing the gateway is forward recovery only: build a new image from a committed revision and
start it against the existing persistent OAuth volume and host config. Never use `docker commit` of
a running container as a rollback image, and never bake live credentials, tokens, or config into any
candidate or rollback image.

## Runtime identity compatibility (N1D)

The runtime carries the QuaranGate identity. Discovery and cleanup remain **dual-read** so
pre-cutover resources stay visible; only new writes use the QuaranGate namespace.

| Concern | Written now | Also read (legacy, never written) |
|---|---|---|
| Ownership labels | `io.quarangate.*` | `io.mcp-ide-bridge.*`, `io.mcp-bridge.*` |
| Evidence volumes | `io-quarangate-evidence-*` | `io-mcp-ide-bridge-evidence-*` |
| Target opt-in discovery | *(not written by the bridge)* | `mcp.bridge.*` |

Notes that matter operationally:

- Docker ANDs the entries of a single `label` filter, so dual-read is implemented as **one query per
  namespace, unioned and de-duplicated** (`managedLabelFilters()` in `src/executor/agents/sandboxSpec.ts`).
  A resource carrying two namespaces is processed exactly once.
- Ambiguity fails safe. If two accepted namespaces disagree on `managed`/`resource`/`job`, the value
  reads as unproven and the resource is **retained**, never deleted.
- Historical evidence is never renamed or migrated. It ages out under its existing retention policy.
- `mcp.bridge.*` target discovery is **deliberately not migrated**: those labels are authored by
  operator Compose files, including ones outside this repo. Changing them here would empty
  `targets_list`. This is its own, longer compatibility window (§47.4).

Identifiers deliberately retained under approved decisions:

- `mcp-bridge-jobs` — durable job/evidence store, physical name retained (§47.13 DECISION-2).
- Target Compose projects (`mcp-ide-bridge-testtarget`, `mcp-ide-bridge-review`) — unchanged; the
  client-facing contract is the target `id`, not the project (§47.7).

Host secret path (§47.8, DECISION-4): `/home/herman/.config/quarangate/kiro-api-key`, with the legacy
`/home/herman/.config/mcp-ide-bridge/kiro-api-key` still supported as a fallback. Resolve it with
`node scripts/resolve-kiro-key-file.mjs` (explicit env → new path → legacy path). Migrate by **moving**
the file, never copying — two live copies of one credential have no source of truth.

## Health / readiness

```bash
curl -s http://127.0.0.1:8787/healthz     # gateway LIVENESS only: process is up
curl -s http://127.0.0.1:8787/readyz      # gateway READINESS: clients config loaded AND executor reachable
docker compose ps
```

`/healthz` never depends on config or executor state. `/readyz` fails closed with `503` unless the
clients config loaded *and* the executor answers. A valid config with zero clients counts as loaded.

The Docker healthcheck for the gateway probes `/readyz` (the executor's own healthcheck still probes
`/healthz`). A missing, unreadable, malformed, or structurally invalid `config/clients.yaml` — for
example an empty `/config` bind mount after a reboot — therefore shows the gateway as **unhealthy**
instead of falsely healthy. The gateway process stays alive and diagnosable; it does not exit or
crash-loop. The reason category is logged at startup (`clients config not loaded`), never returned in
the `/readyz` body.

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


### OAuth data-volume permissions

Fresh gateway images create `/data` as `node:node` with mode `0700`; OAuth state files are written
with mode `0600`. This preserves a non-root gateway while allowing the OAuth façade to persist
registrations and hashed token state.

An existing data volume created by an older image (`quarangate-data`, or the legacy `mcp-bridge-data`) may still be `root:root` and therefore
unwritable by the gateway. Diagnose without reading file contents:

```bash
docker compose exec -T gateway sh -lc 'id; stat -c "mode=%a uid=%u gid=%g path=%n" /data; test -w /data && echo writable || echo not-writable'
```

If the volume is bridge-owned and confirmed to contain no user data requiring different ownership,
stop only the gateway and repair the volume root:

```bash
docker compose stop gateway
docker run --rm --user 0:0 \
  --mount type=volume,source=quarangate-data,target=/data \
  alpine:3.20 sh -eu -c 'chown 1000:1000 /data; chmod 0700 /data'
docker compose up -d --no-deps --force-recreate gateway
```

Do not solve this by running the gateway as root or by making `/data` world-writable.

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

## Remote ingress

Remote browser access is a deliberate operator action because it creates the project's public attack
surface. The gateway itself must remain bound to `127.0.0.1:8787`; never publish the executor.

### Current verified browser ingress — Tailscale Funnel

Approved for Claude and verified on 2026-07-27; reused and verified for ChatGPT on 2026-07-28:

```text
Claude.ai / ChatGPT
   │ HTTPS
   ▼
https://wolf.taildc680e.ts.net
   │ Tailscale Funnel
   ▼
http://127.0.0.1:8787
   │ private Docker network
   ▼
executor (no published ports)
```

The persisted Funnel mapping is:

```text
https://wolf.taildc680e.ts.net
|-- / proxy http://127.0.0.1:8787
```

The corresponding `.env` setting is:

```text
BRIDGE_PUBLIC_URL=https://wolf.taildc680e.ts.net
```

After changing `BRIDGE_PUBLIC_URL`, recreate only the gateway and verify both local and public OAuth
metadata before client authorization. Useful checks:

```bash
curl -fsS https://wolf.taildc680e.ts.net/healthz
curl -fsS https://wolf.taildc680e.ts.net/readyz
curl -fsS https://wolf.taildc680e.ts.net/.well-known/oauth-protected-resource | jq .
curl -fsS https://wolf.taildc680e.ts.net/.well-known/oauth-authorization-server | jq .
tailscale funnel status
```

A public unauthenticated MCP initialize request must return HTTP `401` with OAuth resource metadata;
that check was verified before connecting either browser client. The executor had `Ports: {}` and the
gateway had no `/var/run/docker.sock` throughout Claude and ChatGPT external validation. ChatGPT
action definitions may need an explicit **Refresh** after server-side tool metadata changes; the
14 tools verified at that milestone advertise `outputSchema` and return `structuredContent` plus
legacy JSON text. The current surface is 23 tools (the original 14 plus nine Agent Control Plane
tools), so a Refresh is required after upgrading a client that was connected before A6.

For a different ingress provider or hostname, preserve the same invariants: TLS on, exact
`BRIDGE_PUBLIC_URL`, loopback-only gateway bind, executor private, and no raw Docker socket in the
public-facing gateway. Public-ingress changes still require explicit operator approval.

## Backups / state

The only disposable persistent state is the `quarangate-data` volume (hashed OAuth tokens). It is safe
to drop; the durable agent job/evidence store `mcp-bridge-jobs` is NOT (§47.13 DECISION-2).
clients simply re-authorize. Config lives in `config/*.yaml` (gitignored) and `.env`.
