# Phase A4 — Kiro ACP Read-Only Backend (COMPLETE — PASS)

## Objective

Add a real, read-only AI analysis backend that drives **Kiro CLI 2.5.0** in ACP
(Agent Client Protocol) mode inside a hardened, network-isolated Docker runner,
wired into the existing Agent Control Plane (`AgentJobEngine`) for the
`audit` / `plan` / `review` profiles. Write capability (`implement`) is
explicitly out of scope for A4 (it belongs to A5) and is denied.

Acceptance was proven end-to-end through the **deployed** stack with exactly one
real provider-backed inference turn.

## Runtime facts (authoritative, validated live against Kiro CLI 2.5.0)

- Kiro CLI version: **2.5.0**
- `kiro-cli` SHA256: `0f0e2b8b25a0dae019239b340ce3601e29dd2ea0e63b35f1e685c8d08265c4de`
- `kiro-cli-chat` SHA256: `b2142a355add88b1d234ef405a226781aea5719e841c77c0b15ee1abcb2804fc`
- Runner image (acceptance): `mcp-ide-bridge-kiro-runner:a4`
  `sha256:17de81d318fe3581cff7c13641276e889c07a1f03e751a2cf0adc9181cbb0e6c`
- Bridge/proxy image (acceptance): `mcp-ide-bridge:latest`
  `sha256:f821f24bd1da7cb8836e73f10eb9674a9dfaee527090fac7843b4eea2716cc30`
- ACP protocol version: `1` (number)
- Advertised models (`session/new`): `claude-sonnet-4`, `claude-sonnet-4.5`
  (`claude-haiku-4.5` is accepted as a startup `--model` string but is NOT in
  the advertised list, so it is not used).

## Key findings and decisions

- **`kiro-cli` is a dispatcher.** `--version` / `--help` / `whoami` /
  `diagnostic` are handled in-process, but `acp` / `chat` / `agent` / `mcp` /
  `settings` are delegated to the sibling binary **`kiro-cli-chat`** resolved
  next to the executable. Shipping only `kiro-cli` made `kiro-cli acp` exit 1
  with `error: No such file or directory (os error 2)` while `whoami` passed.
  Fix: ship both binaries; build gate runs `kiro-cli --version` and
  `kiro-cli acp --help`. `kiro-cli-term` is intentionally omitted.
- **HOME/XDG isolation.** `KIRO_HOME` alone is insufficient; auth/state also
  live under `HOME` and the XDG dirs. The runner isolates
  `HOME`, `KIRO_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME` under `/home/runner`. No personal Kiro/Builder-ID state is
  inherited.
- **Workspace-agent precedence.** A workspace `.kiro/agents/<name>.json`
  overrides a global agent of the same name. Mitigation: a **per-job
  unguessable agent name** `mcp_ro_<32 hex>` written only into the isolated
  runner home, so a staged/tracked project cannot pre-stage a colliding file.
  The agent is locked to `read`/`grep`/`glob`, `mcpServers:{}`,
  `includeMcpJson:false`, `hooks:{}`, no wildcard, no fixed model.
- **Production execution wiring.** The Executor never uses a `docker` CLI. It
  launches the runner purely through the trusted Docker Engine API
  (`src/executor/docker.ts`, undici Pool). The ACP JSON-RPC turn is driven by a
  **runner-internal Node driver** (`runnerMain.ts`, reusing the same
  `AcpDriver`) delivered on a read-only, job-scoped control volume together with
  a trusted, non-secret `control.json`. The runner emits a single bounded
  `__ACP_RESULT__` line consumed from the container logs.
- **Credential architecture.** trusted host key file → Executor transient read →
  job-scoped secret volume → runner RO secret file `/run/secrets/kiro-api-key` →
  entrypoint exports `KIRO_API_KEY` for the child only. The raw key is never in
  Docker Env, labels, args, logs, DB, workspace, result, Git, or the Gateway.
  In deployment the key is mounted **only into the Executor** via a Compose
  secret; `AGENT_KIRO_KEY_PATH` is a path, never the value.
- **Backend-only egress.** Runner has no direct Internet. Traffic flows
  runner → job-scoped internal network → allowlist CONNECT proxy → approved
  Kiro/auth hosts on :443. A bounded proxy-readiness gate avoids a startup race.
  Telemetry (`client-telemetry.*`) and the Q update host
  (`desktop-release.q.us-east-1.amazonaws.com`) remain denied.
- **Egress allowlist — inference endpoint.** Root cause of the first failed real
  turn (`ACP -32603 Internal error`): `session/prompt` model inference requires
  egress to **`q.us-east-1.amazonaws.com`** (Amazon Q inference backend), which
  was not allowlisted. Added it (a required paid-inference destination, not
  telemetry). Full allowlist: `runtime.us-east-1.kiro.dev`,
  `runtime.eu-central-1.kiro.dev`, `prod.us-east-1.auth.desktop.kiro.dev`,
  `cognito-identity.us-east-1.amazonaws.com`, `oidc.us-east-1.amazonaws.com`,
  `codewhisperer.us-east-1.amazonaws.com`, `q.us-east-1.amazonaws.com`.
- **Model selection.** Startup `--model` (not a `session/prompt` field).
  `session/prompt` carries only `{sessionId, prompt:[{type:"text",text}]}`.
- **Policy classification remediation.** `backend=kiro` + `profile=implement` is
  a deliberate profile prohibition. It is denied *before* any runner/model
  execution via `assertReadonlyProfile` and now classified as **`FAILED_POLICY`**
  (previously mis-classified `FAILED_INFRASTRUCTURE`). Trusted precondition
  failures map to `FAILED_PRECONDITION`; genuine agent errors to `FAILED_AGENT`.
- **Kiro-IDE historical `-a` deviation.** An earlier exploratory harness used
  `-a`/`--trust-all-tools`; this was rejected. The accepted design uses only
  `--trust-tools read,grep,glob` plus a fail-closed driver that refuses
  privileged server→client requests.

## Real provider acceptance

- Chain: deployed Executor internal dispatch → `AgentJobEngine` → `KiroBackend`
  → Docker Engine API → isolated runner → `runnerMain` → `AcpDriver` →
  `kiro-cli acp` → `claude-sonnet-4`.
- Project: `a4-fixture` (clean disposable git repo; not the main project, whose
  tree carried the uncommitted A4 work).
- Task: read one tracked marker file and return its exact contents.
- Job ID: `job_17d4f0186616651450bf6a12c050055d`
- Backend session ID: `855c613a-772c-48f1-be02-fdc158955c8c`
- Model: `claude-sonnet-4` (advertised)
- Lifecycle: QUEUED → PREPARING → RUNNING → VALIDATING → COMPLETED (exit 0)
- Expected marker `A4-ACCEPT-19E92C7A6EE8` == returned marker (exact)
- `stopReason`: `end_turn`; tool calls observed: `read` only
- Effective tools: read/grep/glob only — WRITE/SHELL/MCP/WEB not available
- Fixture integrity after the turn: HEAD unchanged, worktree clean, marker
  unchanged, no untracked file; `/workspace` read-only; host main project
  unchanged.
- Cleanup: runner, proxy, job networks, workspace/home/control/secret volumes
  all removed; persistent job DB volume untouched.
- Secret non-exposure: `KIRO_API_KEY` absent from Executor/Gateway env, labels,
  args, DB, result, logs, Git.

## Test results

- typecheck PASS; build PASS
- unit: 228/228
- A4 Docker integration: 8/8
- A4 production integration: 3/3
- A3 sandbox regression: 6/6
- A2/agents integration: NOT RERUN — gated on the absent `KEYS_ENV` live-key
  fixture (environment limitation, not a regression).

## Operator configuration requirement

Persistent enablement requires the operator to set, for the Executor only:

- `AGENT_RUNNER_IMAGE=mcp-ide-bridge-kiro-runner:a4` (real runner; never `:a4-test`)
- `AGENT_PROXY_IMAGE=mcp-ide-bridge:latest` (bridge image; contains the proxy)
- `AGENT_KIRO_KEY_PATH=/run/secrets/kiro-api-key` (a PATH, not the key)
- a read-only Compose secret mounting the dedicated key file into the Executor
- `AGENT_KIRO_DRY_RUN` unset/false for normal operation (true = zero-inference
  health/verification mode that stops after `session/new`).

These are documented in `.env.example`. The local `.env` is intentionally NOT
committed (and its automated write is blocked by IDE policy); secrets never
enter Git.

## Status

- **A4: COMPLETE — PASS**
- **A5: READY** (write/`implement` capability is next; must not reuse A4 to gain
  write access).
