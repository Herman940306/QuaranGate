# SH-07 Adversarial Cross-Plane Harness

## Scope and governance

SH-07 is a deterministic, non-destructive adversarial regression gate over the
current QuaranGate source. It composes already accepted security boundaries so
a locally correct subsystem cannot accidentally become a confused deputy when
combined with another plane.

This gate does **not** add product authority and does not weaken any existing
boundary. It is intentionally separate from:

- SH-01 origin / Host / DNS-rebinding hardening;
- SH-03 MCP SDK/protocol-version qualification;
- SH-08 property/fuzz testing;
- SH-09 crash/chaos testing.

The SH-07 candidate is test/documentation-only. A test finding is a product
finding: remediation must change the affected production boundary and add a
regression rather than relaxing the adversarial assertion.

## Frozen adversarial matrix

| Family | Mechanical proof |
| --- | --- |
| Concurrent principal isolation | 64 principals × 12 interleaved AsyncLocalStorage observations preserve exact identity; nested delegation/exception restores the outer principal. |
| Static API key vs OAuth bearer equivalence | A real hashed OAuth access-token record and the real static-key authenticator resolve to the same configured Principal object; both consume one `principal.id` rate-limit bucket. |
| Cross-plane confused deputy | Target-only authority grants no Agent/GitHub authority; Agent-only authority grants no target/GitHub authority; GitHub-only authority grants no target/Agent authority. |
| Hostile observability | Credential-shaped detail is redacted, control characters stay safely JSON-framed, and retained Control Center activity excludes detail entirely. |
| Malformed/oversized multi-plane chain | Traversal/control payloads and over-bound values are independently rejected at Agent, filesystem/path, GitHub and IDE contracts; strict Agent inputs refuse host path, image, Docker socket, privilege and network-mode smuggling. |
| Evidence tamper → apply | Evidence corrupted after durable publication fails canonical re-verification with `ARTIFACT_STORAGE_INTEGRITY_FAILED`, records `ARTIFACT_INVALID`, creates no applier control volume, executes no applier command, writes no apply journal and leaves the job un-applied. |
| Provider failure/throttle authority drift | Cooldown remains backend-scoped; another backend is unaffected; provider state creates no trusted client grant and cannot substitute/fallback to an unauthorized backend. |
| IDE replay/generation binding | A correctly MAC-authenticated frame from the previous generation is still rejected by current session authority; stale-generation event routing, same-sequence replay and post-terminal late events all fail closed. |

## Source tests

Primary SH-07 composition tests:

- `tests/unit/sh07-cross-principal-context.test.ts`
- `tests/unit/sh07-cross-plane-auth.test.ts`
- `tests/unit/sh07-hostile-observability.test.ts`
- `tests/unit/sh07-malformed-boundary-chain.test.ts`
- `tests/unit/sh07-provider-authority-drift.test.ts`
- `tests/unit/sh07-ide-replay-binding.test.ts`
- SH-07 evidence/apply regression inside `tests/unit/a6-b5-apply-engine.test.ts`

The focused qualification must also include the underlying auth, Agent,
observability, IDE/session, path/schema, provider/job-engine, rate-limit and
apply suites so the composition tests cannot pass against stubbed or divergent
primitives.

## Acceptance rule

SH-07 source acceptance requires all of:

1. exact candidate bytes frozen and reviewed;
2. focused adversarial matrix PASS with no skipped/todo tests;
3. repository full unit suite PASS;
4. typecheck PASS;
5. build PASS;
6. `security:invariants` PASS;
7. `git diff --check` PASS;
8. no runtime/source authority delta beyond the already accepted product;
9. truthful classification of any environment-only integration/browser/provider blockers.

Passing SH-07 is **not** a penetration-test certification, fuzzing result,
chaos result, live-provider certification or production-release approval.
