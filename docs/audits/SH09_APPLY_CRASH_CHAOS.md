# SH-09 Apply Crash / Chaos Hardening

## Scope

SH-09 is the bounded crash-consistency and restart-recovery security gate for
QuaranGate apply/write state. It is intentionally separate from SH-08 parser
fuzzing, SH-10 egress/SSRF testing, SH-11 hostile Docker-world testing, and
SH-13 IDE/same-user attacks.

The gate is non-destructive to valuable source. Chaos runs use disposable
on-disk SQLite databases and child processes only. They do not invoke live
Docker, provider APIs, network access, production worktrees, or owner-host
mutation.

## Finding: orphan reconciliation could falsely succeed

The pre-SH-09 `RunnerSandbox.reconcileOrphans()` implementation swallowed
managed Docker inventory errors by converting them to empty lists and swallowed
container/volume/network removal errors while still appending resources to the
`removed*` result arrays.

That behavior is security-relevant for crash recovery. An `agent_apply` applier
container is intentionally mutation-capable and carries the real project as a
read-write bind. If the executor died while that helper existed, a restart could
previously continue after a failed inventory/removal attempt while the stale
applier might still exist. The recovery log/result could also falsely state the
resource had been reconciled.

### Remediation

`RunnerSandbox.reconcileOrphans()` now fails closed:

- managed container/volume/network inventory failures propagate;
- container stop remains best-effort because an already-stopped container may
  legitimately reject `stop`;
- forced container removal must succeed before the resource is reported removed;
- managed non-durable volume removal must succeed before it is reported removed;
- eligible managed network removal must succeed before it is reported removed;
- the already-accepted startup ordering means any reconciler failure occurs
  before `listen()`, keeping the executor unreachable until stale managed
  resources can be proven reconciled.

No Docker authority was added. The remediation uses the already bounded Docker
Authority Broker operations used by the reconciler.

## Real process-death durability matrix

SH-09 adds a child-process fixture executed through `node --import tsx` so the
process receiving `SIGKILL` is the process holding the SQLite connection. Each
case uses a disposable on-disk AgentJobStore database in WAL mode and reopens it
from a new process/context after the kill.

The matrix proves:

1. `STARTED` + SIGKILL -> on restart remains `STARTED`/ACTIVE until the normal
   recovery pass atomically marks `ABORTED_NO_MUTATION` and releases the writer;
   no project quarantine is created.
2. `VERIFYING` + SIGKILL -> same proven-no-host-mutation recovery semantics.
3. `APPLYING` with a committed journal row + SIGKILL -> restart recovery marks
   the attempt and writer `UNCERTAIN`, quarantines the project, preserves the
   durable mutation journal, refuses later apply admission, and is idempotent.
4. verified success committed before SIGKILL remains exactly
   `VERIFIED_SUCCESS` + job `APPLIED` + writer `RELEASED`; restart recovery does
   not downgrade/replay it.
5. SIGKILL after cross-table success writes but before SQLite `COMMIT` exposes
   none of those partial writes after reopen. The old committed `APPLYING` state
   is observed and then recovered conservatively to `UNCERTAIN` + quarantine.
6. SIGKILL after cross-table recovery writes but before `COMMIT` likewise
   exposes none of the partial recovery; a later normal recovery commits the
   complete attempt/quarantine/writer transition atomically.
7. an injected SQLite failure inside `recoverApplyAttempts()` rolls the entire
   transaction back; after removing the injected trigger, a subsequent recovery
   succeeds from the original coherent state.

The fixture's temporary directories are explicitly removed by the tests in
addition to QuaranGate's global clean-test wrapper.

## Existing apply contracts retained

SH-09 qualification deliberately runs the existing apply engine, durable apply
state, live-writer arbitration, startup ordering, evidence/orphan reconciliation,
and network-reconciliation tests together with the new crash tests. This keeps
previously accepted behavior under test, including journal ambiguity,
rollback/UNCERTAIN classification, hardlink/symlink defenses, stale host/base
checks, writer settlement, and fail-closed startup ordering.

## Release-assurance admission

SH-09 adds `security-chaos` to the required release security policy. It is a
fixed Vitest gate, not a caller-provided command:

- fixed scope: `tests/unit/sh09`;
- runner: the existing self-cleaning `run-vitest-clean.mjs` wrapper;
- file parallelism disabled;
- evidence requires a non-empty all-passing Vitest JSON report;
- pending/todo/skipped/non-passing files cannot produce PASS;
- exact source binding is rechecked before and after execution;
- command identity: `vitest-security-chaos`;
- tool identity: the exact locked local Vitest version.

The gate is included in the release policy, release-policy evidence validator,
release assurance orchestrator, and final release evidence bundle. P10/P11
therefore cannot obtain a complete release PASS while omitting SH-09 evidence.

## Current validation status

This document describes the SH-09 implementation candidate and does **not**
constitute source acceptance.

Focused validation completed before freeze:

- apply/recovery/writer/startup matrix: `8/8` files, `214/214` tests PASS;
- release-policy/receipt/bundle plus SH-09 focused matrix: `5/5` files,
  `48/48` tests PASS;
- TypeScript typecheck: PASS;
- diff-check: PASS;
- `/tmp/q`: absent after the focused clean-test run.

Full repository qualification, immutable source freeze, exact release receipt,
strict self-audit, canonical integration and control reconciliation remain
required before SH-09 can be classified source-accepted.

## Non-claims

SH-09 does not claim:

- live Docker daemon crash/kill testing against a valuable project;
- host power-loss/fsync hardware fault simulation;
- SH-10 egress/SSRF qualification;
- SH-11 hostile Docker-world qualification;
- SH-12 prompt-injection authority qualification;
- SH-13 IDE/session/same-user qualification;
- SH-14 external penetration testing;
- SH-15 enterprise operational-security closure;
- unavailable browser/scanner/provenance production release gates;
- P10/A9 or P11 completion.
