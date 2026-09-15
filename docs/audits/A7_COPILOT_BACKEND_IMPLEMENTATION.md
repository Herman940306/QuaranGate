# A7 GitHub Copilot Backend — Current-Line Source Qualification

## Verdict

`SOURCE_CANDIDATE_IMPLEMENTED / OWNER_AUTHORIZED_SELF_AUDIT_IN_PROGRESS / LIVE_PROVIDER_QUALIFICATION_DEFERRED`

This current-line lane implements a real, fail-closed, **read-only** GitHub Copilot CLI ACP backend on top of canonical `5928e226b6d4cfb9be5f5286b7a6b185dae85496`. It does not claim a live Copilot provider PASS, writer support, or production qualification. Herman's current Copilot entitlement/test capability remains inactive; live A7/P5 qualification therefore remains an external gate.

## Current-line identity

- Branch: `feat/a7-copilot-current-gpt`
- Worktree: `/home/herman/projects/QuaranGate-a7-copilot-current-gpt`
- Base: `5928e226b6d4cfb9be5f5286b7a6b185dae85496` (`docs(p7): separate ide source from live acceptance`)
- Historical source input: `3fcdd698ccba926780a361fff01b3b311590889e` (`feat(a7): add governed copilot backend`)
- Integration method: selective current-line transplant and remediation, **not** direct cherry-pick/merge of the historical branch.
- Canonical, `main`, P9, OH1, control and historical dirty worktrees were not mutated by this lane.

## Authority contract

```text
agent_dispatch
  -> existing client scopes + project/backend/profile grants
  -> private executor auth
  -> trusted agents.yaml backend/profile/resource policy
  -> AgentJobEngine durable lifecycle / cancellation / timeout
  -> current-line backend factory chain with exact A8 session-context forwarding
  -> Copilot factory (backend=copilot only; resume explicitly refused)
  -> committed staged workspace volume (read-only in provider runner)
  -> job-scoped credential/home/control volumes
  -> job internal-only network -> exact-host CONNECT proxy -> job external network
  -> hardened non-root Copilot ACP runner
  -> bounded normalized result
  -> read-only validation and durable result
```

The backend adds no public MCP tool, no caller-selected host path, no Docker primitive to a caller, no gateway secret, no public port, no host bind in the provider runner/proxy, and no Docker socket in either provider container. `implement` is rejected for Copilot; canonical writer/artifact/review/apply semantics remain separate and unchanged.

## Public provider interface

Selected interface: GitHub Copilot CLI ACP over stdio. Production runner policy uses a trusted fixed argv; caller data never selects provider flags. Relevant hardening includes:

- ACP/stdio mode;
- trusted bounded model only;
- `view,grep,glob` available-tool surface;
- explicit read allow plus write/shell/url/memory denial;
- built-in MCPs disabled;
- custom instructions disabled;
- remote/remote-export disabled;
- auto-update disabled;
- ask-user disabled;
- temp-dir access disabled;
- Bash environment inheritance disabled;
- experimental features disabled;
- provider logging/color disabled;
- secret environment names registered for provider redaction.

The ACP driver extension is generic and backwards compatible: Kiro retains its existing argv construction unless a trusted provider-specific `acpArgs` vector is supplied. Process-exit diagnostics use a bounded provider label only.

## Startup/configuration

Copilot is disabled by default. Enabling it in trusted `agents.yaml` requires all of:

```text
AGENT_COPILOT_RUNNER_IMAGE   immutable-valid local image reference
AGENT_COPILOT_HELPER_IMAGE   immutable-valid local helper reference
AGENT_PROXY_IMAGE            immutable-valid local proxy reference
AGENT_COPILOT_KEY_PATH       absolute executor credential path
AGENT_COPILOT_MODEL          bounded trusted model identifier
AGENT_COPILOT_EGRESS_HOSTS   comma-separated exact DNS hostnames only
AGENT_COPILOT_DRY_RUN        explicit optional boolean
```

All configured images are validated through the shared image-reference policy and resolved to local immutable Docker image IDs before the runtime backend is advertised. Missing image, missing/unsafe credential, wildcard/URL/IP/path/port egress value, invalid model, unsupported profile, or missing required configuration fails executor startup.

`compose.copilot.yaml` is intentionally an **executor-only** secret/config overlay. It defines no new long-lived service or network. The per-job egress proxy and networks are created by the governed backend. The overlay mounts exactly one Copilot secret into the executor with source-level `mode: 0400`, uid/gid `1000:1000`; it adds no port, Docker socket, device, privileged mode or network authority.

The existing owner-host `start`, `health`, `infra-acceptance`, and candidate `deploy/rollback` scripts now retain the Copilot overlay whenever the trusted runtime env explicitly configures `AGENT_COPILOT_RUNNER_IMAGE`. Missing configured overlay fails closed rather than silently dropping Copilot after restart/deploy. Rollback retains the runtime overlay; candidate deployment validates/uses the candidate overlay.

## Credential boundary

The credential manager performs a **fresh read for every job** so operator rotation/revocation takes effect without executor restart. It:

- rejects missing, symlinked and non-regular paths;
- rejects group/other-readable files;
- bounds file size and token format;
- opens with `O_NOFOLLOW`;
- revalidates the opened descriptor before reading;
- never places raw token bytes in Docker Env/Cmd/labels/job DB/results;
- writes token bytes only into a job-owned secret volume at mode `0400`;
- mounts that volume read-only into the provider runner;
- exports `COPILOT_GITHUB_TOKEN` only inside the runner entrypoint immediately before exec;
- unsets `GH_TOKEN`/`GITHUB_TOKEN`;
- retries secret-volume revocation and fails infrastructure cleanup if revocation cannot be proven.

Generic startup orphan reconciliation recognizes the same managed/job/resource labels and therefore cleans Copilot secret/home/control/workspace/container/network resources after crashes without adding a Copilot-specific broad deletion authority.

## Sandbox and network boundary

Runner:
- uid/gid `1000:1000`;
- read-only root filesystem;
- all capabilities dropped;
- `no-new-privileges`;
- private IPC;
- no devices/group additions/host PID;
- bounded memory/CPU/PIDs/runtime/output;
- no-exec disposable tmpfs;
- exactly volume mounts: workspace RO, secret RO, home RW, control RO.

Per-job proxy:
- read-only root filesystem;
- all capabilities dropped;
- `no-new-privileges`;
- no mounts;
- no published port;
- bounded memory/PIDs;
- attached to the runner's internal network and a separate external network;
- exact-host allowlist only; CONNECT port `443` only; IP literals/private/link-local/mapped destinations rejected by the shared egress proxy.

No exact Copilot production hostname set is authorized by source implementation. `AGENT_COPILOT_EGRESS_HOSTS` remains an owner-configured exact list, to be derived/approved during later live qualification.

## Result and failure semantics

A Copilot job is not accepted merely because a result marker exists. Success requires:

- runner did not time out;
- container exit code is exactly zero;
- output is not truncated;
- result schema is valid and bounded;
- `ok=true`;
- no refused privileged ACP server->client request occurred;
- every observed tool kind remains within the read-only set;
- non-dry-run completion has `stopReason=end_turn`;
- non-dry-run assistant output is non-empty.

Tool aggregate counts, status strings, assistant bytes, stop reason and refused-request counts are bounded before persistence. Raw provider stderr/wire state is not returned. Another backend is never substituted when Copilot is requested but unavailable.

Docker create ambiguity is handled using deterministic per-job names: cleanup attempts the tracked ID when available and otherwise attempts the deterministic runner/proxy name so a create that succeeded server-side but failed before returning an ID cannot silently strand the resource. Cleanup failure is infrastructure failure, not provider success.

## Session compatibility

Current A8 session context is forwarded intact through the new pure `composeRuntimeBackendFactories()` helper to every provider factory. This closes a current-line composition seam where a generic composed factory could otherwise lose a Kiro resume context. Existing Kiro session-continuity tests remain green.

Copilot itself explicitly throws `SESSION_NOT_RESUMABLE` when a session context is supplied. No live provider-state persistence/resume claim is made until it is separately designed and qualified.

## Deterministic validation

Current-line validation before freeze:

- focused Copilot gate: `119/119 PASS` after reviewer-derived failure/cleanup hardening;
- widened A7/current-line compatibility matrix: `354/354 PASS across 12 files`;
- full unit: `99/99 files / 2692/2692 tests PASS`;
- TypeScript typecheck: PASS;
- build: PASS;
- changed shell syntax: PASS;
- `git diff --check`: PASS;
- targeted secret scan: `0` findings across the scanned executor/config/script surfaces;
- parsed Compose/source-mode boundary: PASS.

The earlier one-test widened failure was a reviewer test expectation error: Node's YAML parser represents source literal `mode: 0400` numerically as decimal `400`. The final contract checks parsed source/target/uid/gid plus the literal source token `mode: 0400`; no product change was required.

## Self-audit findings remediated before freeze

The historical A7 patch was **not** accepted unchanged. Current-line audit/remediation includes:

1. eliminate cross-job token caching; fresh credential read per use;
2. use exact long-form executor secret metadata;
3. validate and resolve all runtime images through current shared image policy;
4. preserve A8 session context through factory composition;
5. explicitly refuse unqualified Copilot resume;
6. reject nonzero provider-container exit even if stdout contains an `ok:true` marker;
7. reject nonzero ACP refused-request count;
8. require normal `end_turn` and usable output for real runs;
9. bound tool/result aggregates and result fields;
10. deterministic proxy/runner name cleanup after ambiguous create;
11. remove unused proxy host-bind configuration;
12. preserve explicitly configured Copilot overlay across owner-host start/health/acceptance/deploy/rollback;
13. keep operator config/example docs aligned with current implement/read-only semantics.

This source is being reviewed under Herman's standing owner-authorized strict self-audit exception. It must be labeled `OWNER_AUTHORIZED_SELF_AUDIT_PASS` only after immutable freeze and post-commit reproduction; it is **not** an independent review.

## Current modified path set

Expected current-line candidate paths include:

- `.env.example`
- `MCP_IDE_BRIDGE_MASTER_PRD.md`
- `README.md`
- `compose.copilot.yaml`
- `config/agents.example.yaml`
- `docs/audits/A7_COPILOT_BACKEND_IMPLEMENTATION.md`
- `scripts/remote-owner-deploy-candidate.sh`
- `scripts/remote-owner-health.sh`
- `scripts/remote-owner-infra-acceptance.sh`
- `scripts/remote-owner-start.sh`
- `src/executor/copilotConfig.ts`
- `src/executor/index.ts`
- `src/executor/agents/acpDriver.ts`
- `src/executor/agents/backendFactoryChain.ts`
- `src/executor/agents/copilotBackend.ts`
- `src/executor/agents/copilotCredentialManager.ts`
- `src/executor/agents/copilotFactory.ts`
- `src/executor/agents/copilotRunnerMain.ts`
- `tests/unit/a7-copilot-backend.test.ts`
- `tests/unit/remote-owner-config.test.ts`

No P9, OH1, project-control, `main`, provider credential, runtime, Docker object or network was mutated by source implementation.

## Remaining A7/P5 live qualification

Source acceptance does **not** close live A7/P5. When Herman activates a real Copilot entitlement/test capability, separately prove:

1. least-authority supported automation credential;
2. exact minimum egress host set under the active account/plan;
3. pinned runner/helper/proxy artifacts containing the supported Copilot CLI;
4. real ACP initialize/session/new/prompt;
5. real audit/plan/review inference;
6. cancellation, timeout, provider failure and restart cleanup;
7. no secret in inspect/log/result/evidence;
8. no Docker/host-path/provider fallback authority;
9. live read-only repository non-mutation;
10. session continuity only if separately designed/qualified.

Writer/`implement` support remains intentionally unsupported for Copilot. If ever added, it requires its own writable-sandbox/artifact/review/apply qualification and must not be inferred from read-only A7.
