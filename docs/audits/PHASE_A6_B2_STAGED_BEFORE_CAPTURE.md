# Phase A6-B2 — Pristine STAGED_BEFORE Capture

**Status:** COMPLETE — PASS

**Implementation commit:** `26c97f9142cc93b4651b99725b7316255dd6b1bb`  
**Parent:** `6c22e06229881ca16189e2bb031d9653c1e9d1e1`  
**Subject:** `feat: capture A6 staged-before evidence`

---

## Purpose

B2 establishes immutable pre-model evidence of the actual staged sandbox workspace. The required ordering is:

1. Trusted staging (project snapshot written to job workspace volume by Executor)
2. **STAGED_BEFORE capture** (B2 — this phase)
3. Mutation-capable model execution (Kiro ACP runner)

Capture failure prevents model execution. If the STAGED_BEFORE evidence cannot be successfully produced and persisted, the job engine does not proceed to runner launch.

B2 does NOT implement POST capture, delta computation, apply, or discard. It is exclusively the pre-model evidence gate.

---

## Implementation Scope

### Committed Files (6)

| Path | Status |
|------|--------|
| `src/executor/agents/beforeCapture.ts` | Added |
| `src/executor/agents/kiroBackend.ts` | Modified |
| `src/executor/agents/sandboxRunner.ts` | Modified |
| `src/executor/agents/sandboxSpec.ts` | Modified |
| `src/shared/errors.ts` | Modified |
| `tests/unit/a6-b2-before-capture.test.ts` | Added |

### Unchanged

- `jobStore.ts` — unchanged
- Schema remains **v3** (`AGENT_JOB_SCHEMA_VERSION = 3`)
- No SQLite schema migration

---

## Evidence Storage Architecture

### Dedicated Per-Job Evidence Volume

Each job that reaches the capture gate receives a dedicated Docker-managed evidence volume:

```
io-mcp-ide-bridge-evidence-<jobId>
```

Created by trusted Executor code. Docker labels include the established managed/job/resource classification, with:

```
resource=evidence
```

### Volume Properties

- **Not caller-controlled** — volume identity derived from jobId by Executor, never from public input
- **Not a host bind** — Docker-managed named volume
- **Not `/jobs`** — separate from the job workspace volume
- **Not `/tmp`** — durable Docker volume
- **Not Executor rootfs persistence** — not stored on Executor container filesystem
- **Not SQLite** — binary evidence stored externally to the database
- **Never mounted into the Kiro/model runner** — the runner container cannot read or write evidence

### Capture Helper Contract

The trusted capture helper receives:

- **workspace:** READ ONLY — the staged project snapshot
- **evidence:** READ WRITE — the dedicated evidence volume

### Lifecycle

- Successful capture: evidence volume survives normal runner cleanup
- Failed/incomplete capture: evidence volume is removed immediately
- A3 ephemeral resource reconciliation intentionally does not remove `resource=evidence` volumes

---

## Capture Content

The STAGED_BEFORE evidence preserves for each workspace entry:

- Normalized workspace-relative path
- Entry kind (file, directory, symlink)
- Relevant mode (permission bits)
- Exact byte size (for regular files)
- SHA-256 of exact bytes (for regular files)
- Exact regular-file bytes

### Properties

- Binary/non-UTF8 safe — arbitrary byte content preserved without encoding assumptions
- Zero-byte safe — empty files captured with valid hash and zero size
- Deterministic ordering — entries sorted for reproducible evidence
- No truncation accepted as valid evidence — partial capture is a failure

---

## Entry Safety

### Implemented Behavior by Entry Type

| Entry Type | Behavior |
|------------|----------|
| Regular file | Bytes preserved (hash + content + size + mode) |
| Directory | Metadata only (path + kind + mode) |
| Symlink | Metadata only, never followed |
| Hardlink / tar link | Represented according to the implemented non-following policy |
| Device / FIFO / special unsupported types | Fail closed |
| Null / unknown entry type | Fail closed |
| Path traversal / unsafe path | Fail closed |

No silent omission. Every entry is either fully captured or causes a closed failure.

---

## Resource Policy

Aggregate evidence sizing is governed by trusted:

```
job.policy.maxEvidenceBytes
```

There is no second aggregate byte authority.

A structural entry-count safety bound exists separately to prevent unbounded iteration over extremely large workspace trees.

---

## Security Invariants

B2 preserves the existing privilege separation:

| Component | Invariant |
|-----------|-----------|
| Gateway | No Docker socket |
| Executor | Sole Docker authority |
| Runner | No Docker socket, no evidence volume, no privileged mode, no arbitrary host filesystem expansion |
| Existing egress/network restrictions | Unchanged |

### Public Caller / Model Restrictions

- Cannot choose evidence volume identity
- Cannot choose Docker mounts
- Cannot control evidence lifecycle

---

## B1 Invariants

- `AGENT_JOB_SCHEMA_VERSION = 3`
- `jobStore.ts` unchanged
- No new B2 SQLite tables
- No source bytes in SQLite
- No `artifact_hash` created
- No artifact `AVAILABLE` state
- No artifact applicable state
- A6-B1 remains frozen

---

## A5 Non-Regression

A5 baseline/change detection remains intact. B2 capture is additive and occurs before the existing baseline-manifest/change detection workflow.

B2 does not replace A5 evidence. The two mechanisms serve different purposes: A5 detects changes after model execution; B2 preserves pristine pre-model state.

---

## Validation

| Suite | Result |
|-------|--------|
| B2 (`a6-b2-before-capture.test.ts`) | 44/44 PASS |
| Full unit suite | 381/381 PASS |
| A3 sandbox (`agent-sandbox.test.ts`) | 22/22 PASS |
| A4 Kiro backend (`a4-kiro-backend.test.ts`) | 18/18 PASS |
| A6-B1 apply state (`agent-apply-state.test.ts`) | 49/49 PASS |
| Typecheck | PASS |
| Build | PASS |
| `git diff --check` | PASS |
| Independent A6-B2 acceptance audit | PASS |

---

## B2 Boundary

### NOT Implemented in B2

- POST capture
- Delta (BEFORE vs POST comparison)
- Canonical final artifact
- `artifact_hash`
- Artifact `AVAILABLE` / applicable state
- Host-base certification
- `agent_diff` activation
- Apply execution
- Discard execution
- Rollback
- A6-B3
- A7

---

## Next-Phase Obligations

The following are future A6 obligations, NOT B2 defects:

1. **Durable linkage** between retained evidence and persistent job/artifact state.

2. **POST capture** and deterministic BEFORE-to-POST delta.

3. **Canonical artifact/manifest construction.**

4. **Evidence retention / expiry / disposition lifecycle.** Discarded work/evidence must remain reviewable according to retention policy. Discard does NOT automatically delete evidence.

5. **Evidence cleanup** must respect existing A6 disposition semantics. A job with any UNCERTAIN apply attempt cannot be discarded. The project remains quarantined until explicitly resolved outside normal A6 MCP disposition.

6. **Retained resource garbage collection/recovery** must distinguish legitimate evidence from abandoned/incomplete resources.

7. **Reconcile future durable volume references** with the existing schema-v3 A6 artifact fields before proposing any new database schema.

---

## Known B2 Residual

Successful `resource=evidence` volumes intentionally survive the current ephemeral reconciler. Until later A6 lifecycle handling exists, successful B2 evidence has no final retention/GC lifecycle.

This is an explicitly deferred A6 obligation, not an implementation failure of B2.
