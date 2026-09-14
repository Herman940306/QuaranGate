# P7 I2 — VS Code live qualification infrastructure

Date: 2026-09-14

Status: **QUALIFICATION INFRASTRUCTURE CANDIDATE / LIVE QUALIFICATION NOT RUN**

Authorized base source: `f1432e63a7ff2e315fbc0738a26c81b818bd4904` (`feat(ide): add vscode public-api model execution`)

Authorized branch: `lane/p7-i2-vscode-qualification`

Authorized isolated worktree: `/workspace/QuaranGate-i2-vscode-qualification`

## Scope

This lane adds qualification/evidence infrastructure only. It does **not** alter production VS Code adapter code, project control, startup wiring, deployment, public MCP tools, model execution authority, Chat Participant composition, or implementation/mutation capability.

Authorized paths:

- `scripts/vscode-remote-wsl-qualification.mjs`
- `scripts/vscode-qualification-evidence.mjs`
- `tests/integration/p7-i2-vscode-qualification.test.ts`
- `tests/fixtures/vscode-qualification/**`
- `docs/audits/P7_I2_VSCODE_LIVE_QUALIFICATION.md`

`SHARED_PATHS: NONE`.

## Purpose

The infrastructure is intended to make later live VS Code Remote-WSL qualification deterministic, bounded, non-destructive, and evidence-producing while preserving the accepted authority chain.

It prepares evidence categories for:

- Remote-WSL / workspace extension-host placement;
- B4 runtime binding;
- B6 authenticated session/generation;
- B5 physical workspace identity;
- supported public VS Code model API availability;
- persisted user model-access/consent state;
- review execution;
- exact-operation cancellation;
- disconnect/backpressure behavior;
- reconnect/new-generation behavior;
- workspace drift.

The scripts do not create or simulate production authority. A missing live probe remains `NOT_RUN`; an unavailable environment remains `BLOCKED_ENVIRONMENT`; an unsupported capability remains `NOT_SUPPORTED`.

## Evidence classifications

Every qualification step uses one of:

- `PASS`
- `FAIL`
- `BLOCKED_ENVIRONMENT`
- `NOT_SUPPORTED`
- `NOT_RUN`

The evidence layer never maps an absent or blocked live observation into `PASS`.

## Bounded/redacted evidence

`vscode-qualification-evidence.mjs`:

- emits canonical JSON evidence with a manifest SHA-256;
- bounds string, array, object-key, and nesting sizes;
- redacts credential/secret/auth/token/prompt/raw-response/editor/file-content fields;
- records exact step status and timestamp;
- writes evidence with mode `0600` and exclusive-create semantics when an output file is requested.

The default evidence model favors metadata, hashes, versions, operation identifiers, lifecycle state, and bounded error classification rather than prompt/response bodies or workspace dumps.

## Safe fixture boundary

The committed seed under `tests/fixtures/vscode-qualification/workspace-seed/` is read-only input for tooling tests.

Any future disposable mutation target must resolve beneath the operating-system temporary directory and have the explicit `quarangate-vscode-qualification-` prefix. Canonical QuaranGate, project-control, owner-host-control, and arbitrary repository paths fail closed.

The workspace identity helper rejects symlinks and bounds both file count and total bytes before hashing deterministic relative-path/file-content evidence.

## Live execution boundary

This candidate does **not**:

- deploy a VSIX;
- change VS Code settings;
- restart VS Code or Remote-WSL;
- request model consent;
- invoke a paid/provider model;
- mutate a real project;
- exercise an implementation writer;
- use UI automation.

Live qualification requires a later explicit authorization and a real supported VS Code/Remote-WSL environment.

## Required future live evidence

### Remote-WSL placement

`LIVE_VSCODE: NOT_RUN`

`REMOTE_WSL: NOT_RUN`

A future PASS must mechanically prove that the QuaranGate extension executes in the workspace/remote extension host for the target WSL workspace. Merely opening a Remote-WSL window is insufficient evidence.

### B4/B6

`B4_RUNTIME_BINDING: NOT_RUN`

`B6_AUTHENTICATED_SESSION: NOT_RUN`

A future PASS must bind the observed extension process to the expected owner-controlled B4 credential/runtime identity and exact authenticated B6 session/generation without fallback transport.

### B5 workspace identity

`B5_WORKSPACE_IDENTITY: NOT_RUN`

A future PASS must prove the exact live physical Git/worktree identity and must include a negative workspace-switch/drift case.

### Public VS Code model API / consent

`MODEL_API: NOT_RUN`

`MODEL_ACCESS: NOT_RUN`

A future PASS must distinguish public-API absence, no supported model, consent required, denied/revoked access, model disappearance, provider failure, and authorized availability. Qualification must not obtain consent on behalf of the user.

### Review execution

`REVIEW_MODEL_EXECUTION: NOT_RUN`

A future PASS must preserve the exact QuaranGate operation identity, produce bounded ordered output, demonstrate zero workspace mutation for review, and record the terminal lifecycle state.

### Cancellation / disconnect / backpressure

`CANCELLATION: NOT_RUN`

`DISCONNECT: NOT_RUN`

`BACKPRESSURE: NOT_RUN`

Future qualification must cover cancel-before-send, cancel-mid-stream, disconnect during streaming, output-bound exhaustion/stall, and no false completion.

### Reconnect / generation

`RECONNECT_GENERATION: NOT_RUN`

A future PASS must prove that VS Code/Remote-WSL extension-host restart or reconnect yields a fresh generation and that stale generation/operation material cannot resume authority.

## No UI automation

Authority-critical qualification is machine-facing. This infrastructure does not use Playwright against VS Code UI, mouse/keyboard automation, synthetic chat typing, DOM scraping, or private VS Code/Copilot APIs.

Visual/demo artifacts may be added later as non-authority evidence only after functional qualification is complete and separately authorized.

## Validation target

Before this qualification-infrastructure candidate is accepted, validation must prove:

- only the authorized paths changed;
- focused integration tests PASS;
- no production/startup/public authority graph changed;
- `git diff --check` PASS;
- relevant project typecheck/build remain PASS where applicable;
- no live qualification was executed by this candidate.

## Explicit non-claims

This document does not claim:

- live VS Code or Remote-WSL qualification;
- live model availability or consent;
- provider entitlement/quota;
- Chat Participant source acceptance;
- implementation/mutation acceptance;
- Cursor acceptance;
- I2 completion;
- P7 final acceptance;
- deployment;
- branch convergence.

## Candidate validation receipts

The qualification-infrastructure candidate was validated without executing live VS Code/provider qualification.

### Focused qualification infrastructure

- `tests/integration/p7-i2-vscode-qualification.test.ts`: **12/12 PASS** across 1 file.
- The tests prove result-class separation, bounded/redacted evidence, immutable source attribution, fixture confinement, disposable-target refusal for valuable repository paths, deterministic workspace identity/drift detection, honest WSL classification, `NOT_RUN` handling for absent live evidence, derived runtime-probe classification, and malformed-input fail-close behavior.

### Existing I2/public-model regression

The unchanged accepted I2/public-model surface was rerun against the candidate:

- `tests/unit/ide-companion-remote-transport.test.ts`
- `tests/unit/ide-companion-remote-channel.test.ts`
- `tests/unit/vscode-command-channel.test.ts`
- `tests/unit/vscode-public-api-model-execution.test.ts`

Result: **43/43 PASS across 4 files**.

### Full repository unit regression

A validation mirror was created under ext-backed `/workspace` using the exact candidate bytes and the already installed accepted dependency tree from the forward worktree. The mirror was outside the candidate Git worktree and was removed after validation.

Results:

- typecheck: **PASS**
- build: **PASS**
- canonical `npm test`: **2558/2558 PASS across 88/88 files**

Two earlier validation attempts were not counted as product failures:

1. a mirror under `/tmp` exercised the existing VS Code workspace collector on `tmpfs`; the collector correctly rejects filesystems outside its qualified case-sensitive set;
2. running the entire unit corpus directly from the isolated qualification worktree with an external Vitest binary could not resolve several package dependencies because this isolated lane intentionally has no local `node_modules`.

The final ext-backed validation mirror removed both methodology/environment mismatches without changing candidate source bytes or repository dependencies.

### Qualification CLI dry run

`vscode-remote-wsl-qualification.mjs` was executed without a live runtime probe against source `f1432e63a7ff2e315fbc0738a26c81b818bd4904`.

Observed infrastructure-level evidence:

- evidence schema: `quarangate.vscode-qualification-evidence.v1`
- exact source commit recorded: PASS
- basic governed-container WSL environment signal: PASS
- deterministic fixture seed identity: PASS
- `liveQualificationExecuted`: `false`

All authority/runtime-specific live checks remained `NOT_RUN`, including Remote-WSL extension placement, B4 binding, B6 authenticated session, B5 live workspace identity, workspace drift, public model API, model access, review execution, cancellation, disconnect, backpressure, and reconnect/generation.

The dry run is therefore **not** live VS Code qualification.

### Static scope and authority boundary

- Production `src/**` changes: **NONE**.
- Project-control changes: **NONE**.
- Startup/deployment wiring changes: **NONE**.
- Public MCP changes: **NONE**.
- Production model/participant/mutation adapter changes: **NONE**.
- Live qualification executed: **NO**.
- `git diff --check`: **PASS** before freeze.

The candidate is limited to the authorized qualification/evidence paths listed above.
