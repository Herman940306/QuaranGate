# H1 Post-A8 Collision Inventory

**Status**: All H1 hardening items complete with ZERO A8 collision in implementation.

This document records any deferred integration work required when merging H1 and A8 lanes.

---

## Non-Collision Summary

**Result**: H1 implementation completed with NO edits to A8-frozen files.

**A8-frozen files verified untouched**:
- `src/shared/errors.ts`
- `src/executor/agents/acpDriver.ts`
- `src/executor/agents/jobEngine.ts`
- `src/executor/agents/jobStore.ts`
- `src/executor/agents/kiroBackend.ts`
- `src/executor/agents/kiroFactory.ts`
- `src/executor/agents/runnerMain.ts`
- All new A8 files: `sessionStore.ts`, `sessionPolicy.ts`, `tests/unit/a8-*.test.ts`, `docs/audits/A8_*`

---

## A7 Surface: compose.yaml Executor Healthcheck

**File**: `compose.yaml` line ~107-115

**H1-2 Change**:
```yaml
# H1-2: Executor readiness check (docker.sock authority verification)
# Changed from /healthz to /readyz — proves Docker socket is live and answering.
# Must merge with any A8 compose.yaml changes to the executor service definition.
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:3001/readyz').then(r=>r.ok?process.exit(0):process.exit(1))"]
  interval: 10s
  timeout: 5s
  retries: 3
  start_period: 5s
```

**A7 Context**: The A7 audit noted this gap — executor healthcheck still used `/healthz` (process liveness only), not `/readyz` (Docker socket authority). H1-2 fixes this.

**Merge Strategy**:
- If A8 modified the executor service (ports, env vars, mounts), manually reconcile.
- The healthcheck change is a single-line URL swap: `/healthz` → `/readyz`.
- Comment in `compose.yaml` explicitly marks this as H1-2 for merge visibility.

**Risk**: LOW — A8 session continuity does not touch the executor healthcheck or `/readyz` endpoint.

---

## Test Isolation: No A8 Test Conflicts

**H1-5 Test Fix**: `tests/unit/a5-implement-policy.test.ts`

H1-5 modified this test to set `ACP_MOCK_WORKSPACE` env var and use a disposable temp workspace instead of hardcoded `/workspace`. This change is in an EXISTING A5 test file (not A8-frozen).

**A8 Impact**: NONE — A8 does not modify A5 test files.

**Verification**: The modified test passes in H1 and will continue to pass after A8 merge (A8 adds new tests but does not change A5 tests).

---

## kiroBackend.ts Network Labels (Read-Only Observation)

**H1-6 Discovery**: `kiroBackend.ts` (A8-frozen) labels egress networks with:
```typescript
{ [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'net', [LABEL_JOB]: this.job.jobId }
```

**H1-6 Implementation**: `sandboxRunner.ts` `reconcileOrphans()` now matches `resource='net'` (not inventing new labels).

**A8-Frozen File**: `kiroBackend.ts` — H1 never edited it.

**Merge Impact**: NONE — H1 reads the label convention; A8 continues to write it unchanged.

---

## New H1 Files (No A8 Equivalents)

The following files are NEW in H1 and have no A8 counterparts:

**Source**:
- `src/shared/imageRef.ts` (H1-1 central image parser)
- `src/executor/readiness.ts` (H1-2 `/readyz` endpoint)

**Scripts**:
- `scripts/workstation-doctor.sh` (H1-3 stale bind detector)
- `scripts/remote-owner-recover.sh` (H1-4 bounded recovery)

**Tests**:
- `tests/unit/h1-image-ref.test.ts`
- `tests/unit/h1-readiness.test.ts`
- `tests/unit/h1-fixture-isolation.test.ts`
- `tests/unit/h1-network-reconciliation.test.ts`
- `tests/unit/h1-scripts-syntax.test.ts`

**Docs**:
- `docs/EGRESS_AUDIT_H1.md`

**Merge Strategy**: Direct addition (no conflicts).

---

## Modified H1 Files (A8 May Also Modify)

### High-Collision Surface

**NONE** — all H1 changes are in files A8 does not touch, or in isolated new modules.

### Low-Collision Surface

**Files H1 modified that A8 MIGHT also modify**:

1. **`src/executor/index.ts`**:
   - H1-1: 3 call sites for `parseImageRef()` (lines ~416, ~437, ~458)
   - H1-2: `/readyz` route registration (line ~89)
   - H1-6: `reconcileOrphans()` log includes `removedNetworks` (line ~109)
   - **A8 Risk**: LOW — A8 session continuity adds new routes but does not refactor existing startup/healthcheck.

2. **`src/executor/agents/sandboxRunner.ts`**:
   - H1-6: `reconcileOrphans()` extended with network sweep (lines ~306-372)
   - H1-6: Return type includes `removedNetworks`
   - **A8 Risk**: LOW — A8 does not modify `reconcileOrphans()` (session continuity is in `kiroBackend.ts`, which is A8-frozen).

3. **`src/executor/agents/startupPolicy.ts`**:
   - H1-1: Call `parseImageRef(AGENT_RUNNER_IMAGE)` and `parseImageRef(AGENT_PROXY_IMAGE)` (lines ~65-66)
   - **A8 Risk**: LOW — A8 does not modify startup policy validation.

4. **`src/executor/agents/githubControl.ts`**:
   - H1-1: 2 call sites for `parseImageRef()` (lines ~126, ~173)
   - **A8 Risk**: NONE — A8 does not touch GitHub control plane (A7 feature).

5. **`src/executor/docker.ts`**:
   - H1-6: `NetworkSummary` interface extended with `Containers` field (line ~336)
   - **A8 Risk**: LOW — A8 does not modify Docker API types (session continuity uses existing Docker primitives).

6. **`tests/fixtures/mock-acp-impl-server.mjs`**:
   - H1-5: Read `ACP_MOCK_WORKSPACE` env var instead of hardcoded `/workspace` (line ~19)
   - **A8 Risk**: NONE — A8 does not modify A5 fixtures.

7. **`tests/unit/a5-implement-policy.test.ts`**:
   - H1-5: Set `ACP_MOCK_WORKSPACE` env var, use disposable temp workspace (lines ~162-179)
   - **A8 Risk**: NONE — A8 does not modify A5 tests.

8. **`compose.yaml`**:
   - H1-2: Executor healthcheck changed from `/healthz` to `/readyz` (line ~110)
   - **A8 Risk**: MEDIUM — A8 MAY modify executor service definition for session continuity (new env vars, mounts, etc.).
   - **Merge Note**: Manual reconciliation required. A8 changes + H1 healthcheck URL change = trivial merge (both are additive).

---

## Deferred Items Requiring A8-Frozen File Edits

**Result**: NONE.

All H1 hardening items were implemented WITHOUT editing A8-frozen files. No deferred work is required after A8 completes.

---

## Post-Merge Verification Checklist

After merging both H1 and A8 into a common integration branch:

1. **Typecheck**: `npm run typecheck` — must PASS
2. **Build**: `npm run build` — must PASS
3. **Unit Tests**: `npm test` — all H1 + A8 tests must PASS
4. **Integration Tests**: `npm run test:integration` — full stack must PASS
5. **compose.yaml**: Verify executor healthcheck is `/readyz` (H1-2)
6. **A5 Fixture**: Verify `mock-acp-impl-server.mjs` reads `ACP_MOCK_WORKSPACE` (H1-5)
7. **Orphan Reconciliation**: Verify `reconcileOrphans()` returns `removedNetworks` (H1-6)
8. **Image Validation**: Verify `parseImageRef()` rejects `:latest` and malformed refs (H1-1)

---

## Final Disposition

**H1 Lane**: Clean, complete, no A8 collision.

**A8 Lane**: Independent session continuity work in A8-frozen files.

**Integration**: Trivial merge — no overlapping edits, one compose.yaml healthcheck line to reconcile.

**Approval Gate**: Both lanes independently verified before merge.
