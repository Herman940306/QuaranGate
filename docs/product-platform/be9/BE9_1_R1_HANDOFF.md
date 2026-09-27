# BE9.1 R1 — lifecycle/binding remediation handoff

Status: `SOURCE_CANDIDATE_READY_FOR_FREEZE / NOT_SELF_ACCEPTED`

Accepted backend base:

```text
324abd6da9360197b3af28bfcc95fc7c987a1cdd
```

Pre-remediation BE9.1 commit:

```text
9e863bc8d5f76da68b4b9a40cf1ac72f0aba19ef
tree 86e411ee213c0834d0168fe31c92726e9f5fe9d4
subject feat(product): add BE9 assessment lifecycle foundation
```

This R1 was produced after independently re-deriving the concerns in
`/workspace/QuaranGate-agent-orchestration/BE9_IMPLEMENTATION_HANDOVER_CONCERNS_20260927.md`
against the current BE9.1 HEAD.

## Reproduced and remediated

1. **Real BE8 snapshot binding**
   - BE9.1 consumes the actual `SecurityDiscoveryResult` and `SecurityAssessmentPlan` types.
   - Plan binding uses `plan.provenance.discoveryId`, not a synthetic top-level field.
   - Creation/reload fails closed on mismatch of `discoveryId`, `planId`, project, optional target, every source-revision representation, planner/detector version, BE8 safety classification, or `executionAuthority !== false`.
   - Unknown fields fail closed at discovery/plan top level and in nested safety, technology, detector provenance, unsupported-fact, and capability-applicability objects.
   - Nested BE8 enums and bounded arrays/strings are runtime-validated before persistence/reload.

2. **Event-derived lifecycle semantics**
   - callers no longer select arbitrary `nextState` + `pendingOutcome`;
   - a closed BE9 event set derives both;
   - `SUCCESS` is reachable only through `RUNNING + TOOL_SUCCESS`;
   - `CLEANUP_PROVEN` derives the terminal state from persisted pending outcome;
   - evidence-finalization failure maps to `FAILED_INFRASTRUCTURE`;
   - unprovable cleanup maps to `CLEANUP_FAILED`;
   - temporary admission unavailability is a versioned `PLANNED -> PLANNED` event;
   - terminal states reject all future lifecycle events.

3. **Restart / journal integrity**
   - when a transition journal exists, it is validated as a contiguous suffix;
   - assessment identity, state chain, event legality, pending outcome, version progression, actor, correlation ID and timestamp ordering are checked;
   - final record state/version/outcome/updatedAt must agree with the final journal entry;
   - an empty journal remains permitted because the frozen persistence contract defines the journal as optional.

4. **Snapshot canonicalization / secret-screen false positive**
   - the prior heuristic incorrectly rejected the real BE8 field `credentialRequirements`;
   - secret-key screening is exact-field oriented rather than substring-based;
   - non-JSON values, non-finite numbers and non-plain objects fail before hashing;
   - secret-pattern screening remains defense-in-depth, not the final PostgreSQL authority boundary.

5. **Durable foundation hardening**
   - BE3 `principalRef` length matches the accepted 256-character contract;
   - discovery/plan IDs use accepted BE8 formats;
   - transition reason/actor/correlation/timestamps are validated;
   - lifecycle timestamps cannot move backwards;
   - contradictory terminal pending outcomes fail closed on reload;
   - active enumeration is named `listActiveForRecovery()` and documented as trusted recovery-only.

## Deliberately not implemented in R1

The following remain downstream BE9.2+ gates:

- product/MCP tenant + discovery admission semantics;
- durable BE8 discovery persistence across process restart;
- governed production `SecuritySourceAdapter`;
- BE1A lease generalization for assessment owners;
- exact-revision source staging;
- assessment-specific Docker Authority roles;
- PostgreSQL migration allocation;
- product→operational admission bridge;
- product/MCP tenant-concealment behavior;
- scanner/evidence/runtime execution.

Do not start those from this unreviewed candidate.

## Migration governance

Observed current accepted migration high-water mark remains `0006_meeting_privacy_policy.sql`.

Nominal next number remains `0007`, but it is **not reserved**. The separate LF0 worktree still owns dirty shared migration/data/package paths. No BE9 migration was created.

## Fresh verification

See `docs/product-platform/be9/evidence/R1/VALIDATION.txt`.

Key results:

- focused BE9: **60/60 PASS**;
- focused BE9 + BE8 + auth + BE3 + route contract: **149/149 PASS**;
- product data migration: **12/12 PASS**;
- BE1A regression: **19/19 PASS**;
- frontend full: **18 files / 300 tests PASS**;
- frontend typecheck: PASS;
- root typecheck: PASS;
- root build: PASS;
- frontend production build: PASS;
- frontend lint: PASS, zero warnings;
- security invariants: PASS (16 rules / 12 compose files / 7 Dockerfiles);
- root + frontend npm audit: 0 vulnerabilities;
- diff-check: PASS;
- bounded added-line high-signal secret scan: 0 findings.

Root full-suite replay was attempted repeatedly. The repository-exclusive `/tmp/q` test root was concurrently reacquired by another agent each time. It remains `BLOCKED_ENVIRONMENT_CONCURRENT_TEST_OWNER`; no foreign temp state was deleted, killed, or bypassed.

## Freeze / acceptance boundary

R1 is not self-accepted.

After this document/evidence is finalized, the implementation writer may freeze exactly these bounded R1 paths into one immutable candidate commit. Independent review must then verify that exact SHA/tree.

```text
BE9_1_R1_ACCEPTED=NO
SELF_ACCEPTANCE=NO
BE9_2_START_ALLOWED=NO_UNTIL_BE9_1_R1_INDEPENDENT_PASS
```
