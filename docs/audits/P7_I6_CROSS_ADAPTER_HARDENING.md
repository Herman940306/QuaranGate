# P7 I6 — Cross-adapter hardening

Date: 2026-09-15

Status: **SOURCE / ADVERSARIAL HARDENING CANDIDATE — LIVE PRODUCTION ACCEPTANCE PENDING UPSTREAM VENDOR GATES**

## Scope and source dependency

This isolated I6 lane hardens and verifies the common Plane-B contracts across the reviewed VS Code and Cursor source foundations. It is based on Cursor source candidate `9dab551e22455d89ccd0d67a9d383c57d6a614b0`, whose base is accepted forward source `d720f0f912ed24f876c9e24fa47b281a58dd87b2`.

I6 deliberately adds **no new production authority**. The accepted B2–B9 source already provides the shared durable session, operation, recovery and writer-arbitration mechanisms. This batch tests those mechanisms as one cross-adapter system rather than introducing a second lock, session store, permission system, host-command path or vendor-specific policy server.

Changed I6 paths are limited to:

- `tests/integration/p7-i6-cross-adapter-hardening.test.ts`
- `docs/audits/P7_I6_CROSS_ADAPTER_HARDENING.md`

No `src/**`, extension runtime, Compose, public MCP, project-control or production deployment byte is changed by I6.

## Cross-adapter properties proven deterministically

The dedicated integration matrix proves:

1. VS Code and Cursor can be provisioned simultaneously from one trusted IDE-session configuration as distinct review-only runtimes with separate runtime IDs, credential files and Unix sockets.
2. A VS Code credential cannot be consumed by the Cursor credential reader and a Cursor credential cannot be consumed by the VS Code reader, even though both products reuse the common Plane-B contract.
3. Reconnect/generation is per exact enrollment: reconnecting VS Code advances only its generation and stales only its old session; the Cursor session remains current.
4. Cross-product session substitution is denied before generation or authority changes.
5. Concurrent read-only review operations may exist for separate authenticated VS Code and Cursor sessions while durable operation rows preserve exact `ideProduct`, session, generation, adapter and operation identity. Cancellation of one product's operation does not alter the other product's operation.
6. Executor/store restart stales live sessions for both products without reviving a historical generation or crossing product identity.
7. The single existing B8 live-writer arbiter is product-neutral: an IDE writer for one adapter blocks a competing IDE writer for the same exact `(projectId, worktreeId)`, while a different worktree remains independent.
8. Restart recovery never silently releases potentially mutating IDE writers. Unresolved IDE writer leases become `UNCERTAIN` and remain blocking.
9. Both production extension entrypoints remain free of arbitrary host-command, terminal, workspace-write, Docker-socket, private Cursor Agent/Composer and Cursor MCP-registration authority.
10. Multi-adapter startup is failure-atomic at the listener boundary: if a later adapter listener fails to bind, already-started listeners are stopped in reverse order rather than leaving a partial live Plane-B surface.

These tests intentionally exercise common durable authority, not vendor UI behavior.

## Initial test-fixture correction

The first development run of the new I6 test file reported **6 PASS / 3 FAIL** before any product assertion in the failed cases. The synthetic VS Code fixture used the non-hex character `v` inside an `ide_<32 hex>` identity. QuaranGate correctly rejected that fixture as malformed.

The fixture was corrected to a valid hexadecimal opaque ID. No production source byte was changed in response. The corrected dedicated I6 matrix then passed **10/10**.

The failed first run is retained here as methodology evidence and is not relabeled as a product failure or a PASS.

## Cross-adapter security regression

The following security-relevant corpus was executed together against the I6 working bytes:

- common B2/B3/B4/B5/B6/B7/B8/B9 store, listener, auth, workspace and operation tests;
- implementation admission/coordinator and shared live-writer arbitration;
- VS Code credential, connection, workspace, command-channel, participant, extension and public-model source tests;
- Cursor credential, connection, workspace, compatibility, command-channel and extension tests;
- I2 VS Code qualification infrastructure regression;
- I3 Cursor qualification infrastructure regression;
- the new I6 cross-adapter integration matrix.

Result:

- **35/35 files PASS**
- **435/435 tests PASS**

## Authority/security invariants preserved

This batch preserves:

- one durable Plane-B session/operation authority model;
- exact product + instance + session + generation binding;
- fresh per-operation workspace authority where required by the existing B5/B3 chain;
- one product-neutral B8 live-writer arbiter shared with `agent_apply`;
- `UNCERTAIN` writers remaining blocking after restart/unproven mutation state;
- review-only production startup composition;
- no public IDE enrollment or mutation API;
- no generic host shell or caller-selected Docker authority;
- no private Cursor Agent/Composer protocol;
- no clipboard/keyboard/mouse UI automation as an authority mechanism;
- no prompt/result body persistence introduced by I6;
- no model/session memory treated as authorization.

## Live acceptance still required

This source/adversarial batch does **not** complete I6 production acceptance by itself.

Current upstream/live truth at freeze preparation:

- VS Code I2 live qualification has real B4/B5/B6/workspace-drift evidence, but final I2 is blocked by a confirmed accepted-source executor Docker healthcheck authentication mismatch. Agent A owns the bounded remediation and resumed live qualification.
- Cursor I3 source foundation is independently reviewed, but the owner host has no Cursor installation in the bounded checked locations; live Cursor extension-host/Chat/LM/session qualification therefore remains external-environment blocked.
- Kiro IDE-session live qualification remains separate from the existing CLI Agent Control Plane and is not fabricated from Kiro backend evidence.
- IDE-host/provider network/data-leakage behavior remains a per-vendor live qualification requirement.

Therefore this batch may prove **I6 source/adversarial hardening**, but must not be promoted to `P7_FINAL_ACCEPTANCE` or `I6_PRODUCTION_ACCEPTED` until the required vendor-live evidence is reconciled.

## Explicit non-claims

This document does not claim:

- final VS Code I2 acceptance;
- live Cursor I3 acceptance;
- Kiro IDE-session acceptance;
- packaged IDE extension acceptance;
- provider entitlement/model execution acceptance;
- IDE-host air-gap or egress acceptance;
- final I6 production acceptance;
- final P7 acceptance;
- deployment;
- branch convergence;
- canonical/main merge.

## Final validation receipts

Validation used a disposable ext-backed `/workspace` mirror with the exact I6 working bytes and the already-installed accepted dependency tree from the forward worktree. No dependency installation or network acquisition occurred.

Final executable validation before freeze:

- dedicated I6 cross-adapter matrix: **10/10 PASS**;
- cross-adapter Plane-B security matrix: **435/435 PASS across 35/35 files**;
- full repository unit corpus: **2653/2653 PASS across 98/98 files**;
- root typecheck: **PASS**;
- root build: **PASS**;
- Cursor extension typecheck: **PASS**;
- Cursor extension build: **PASS**;
- `git diff --check`: **PASS**;
- bounded changed-file secret-pattern scan: **PASS / no findings**;
- bounded authority-surface scan: **PASS**; matches are limited to this document and negative test assertions naming forbidden capabilities.

Two validation-methodology events are preserved rather than hidden:

1. The first dedicated I6 run produced **6 PASS / 3 FAIL** because the new test fixture used the non-hex character `v` in an `ide_<32 hex>` identity. QuaranGate correctly failed closed before the affected product assertions. The fixture alone was corrected and the dedicated matrix then passed 10/10.
2. A later all-in-one final-validation shell removed its temporary mirror while its shell current directory was still inside that mirror. All executable steps in that command had already passed (focused I6, full unit, root typecheck/build, Cursor extension typecheck/build), but the subsequent Git check failed with `Unable to read current working directory`. The overall shell exit was therefore **128 and is not counted as an end-to-end PASS**. The trailing Git/diff/security checks were rerun separately from the real I6 worktree and passed. A clean final validation command is run again immediately before immutable freeze.

No assertion failure, production defect or authority bypass was hidden by either methodology correction.

## Review boundary

ChatGPT authored this isolated I6 candidate and therefore must **not** self-label its later acceptance review as independent. After immutable freeze, a separate read-only reviewer must audit the candidate bytes, validation receipts and authority claims before integration is authorized.
