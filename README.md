# mcp-ide-bridge

A standalone Docker deployment that exposes a **remote MCP (Model Context Protocol) server**
letting approved MCP clients — Claude browser, ChatGPT browser, VS Code, Kiro — perform
IDE-style automation (files, terminal, git, processes) **inside explicitly authorized Docker
target containers only**.

> ⚠️ **Security warning.** This bridge can read, write, and execute inside the containers you
> authorize. Access to the Docker socket is high privilege. The design deliberately isolates
> that privilege in a private, non-published `executor` service; the public `gateway` never
> holds the socket. Read [`docs/SECURITY.md`](docs/SECURITY.md) before exposing this to any
> network beyond localhost. **Do not** create a public tunnel without understanding the risks.

## What it does (and doesn't)

- **Does:** confined filesystem CRUD + patch + search, bounded terminal execution, read-only
  git/process inspection — each scoped to one authorized target container and its workspace.
- **Doesn't:** touch the host, touch unrelated containers, mount host directories into the
  public process, or run anything on the WSL/host shell.

## Architecture (two security domains)

```
MCP clients ──Streamable HTTP + auth──▶ gateway (public, NO docker.sock)
                                            │  private internal network + shared token
                                            ▼
                                        executor (private, holds docker.sock, no published ports)
                                            │  Docker Engine API
                                            ▼
                                    authorized target containers only
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick local start

```bash
cd mcp-ide-bridge

# 1. Secrets & config
cp .env.example .env
# set INTERNAL_TOKEN (openssl rand -base64 32) and DOCKER_GID (stat -c %g /var/run/docker.sock)
cp config/bridge.example.yaml   config/bridge.yaml     # define/adjust targets
cp config/clients.example.yaml  config/clients.yaml    # then generate keys ↓

# 2. Generate a client key (prints the key once; stores only its hash)
npm install
npm run gen-key -- vscode        # copy the printed keyHash into config/clients.yaml

# 3. (Optional) start the disposable demo target
docker compose -f test-target/compose.yaml up -d --build

# 4. Start the bridge
docker compose up -d --build
curl -s http://127.0.0.1:8787/healthz && curl -s http://127.0.0.1:8787/readyz

# 5. Smoke test the protocol
API_KEY=<your key> ./scripts/mcp-check.sh
```

The gateway binds to `127.0.0.1:8787` only. Browser clients (Claude/ChatGPT) require a public
HTTPS URL — that is intentionally **not** enabled here (see [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
and [`docs/CLIENT_SETUP.md`](docs/CLIENT_SETUP.md)).

## Client setup

Per-client instructions (Claude browser, ChatGPT browser, VS Code, Kiro) with credential
placeholders: [`docs/CLIENT_SETUP.md`](docs/CLIENT_SETUP.md). Sample configs:
`config/vscode.mcp.example.json`, `config/kiro.mcp.example.json`.

## Tools

`targets_list` `target_inspect` · `fs_list` `fs_stat` `fs_read` `fs_search` `fs_write`
`fs_patch` `fs_delete` · `terminal_exec` · `git_status` `git_diff` `git_log` · `process_list`.
Contracts in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Documentation

| Doc | Contents |
|---|---|
| [PLAN.md](PLAN.md) | The full pre-implementation plan that was executed |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, flows, tool contracts, target model |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model (20 threats) + mitigations + residual risk |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | Current official client requirements + citations |
| [docs/CLIENT_SETUP.md](docs/CLIENT_SETUP.md) | Per-client setup |
| [docs/TARGETS.md](docs/TARGETS.md) | Discovery, opt-in labels, manual targets, permissions |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Build/start/stop/logs/credential lifecycle/ingress |
| [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md) | Exact commands run + results |

## License

MIT.
