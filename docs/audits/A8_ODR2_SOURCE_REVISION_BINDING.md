# QUARANGATE — A8 ODR-2 SOURCE REVISION BINDING

## Status

**Source remediation:** `PASS_CANDIDATE / OWNER-APPROVED HYBRID POLICY IMPLEMENTED`

**Isolated branch:** `fix/a8-odr2-source-binding-gpt`

**Exact base:** `1522680ae356afe963f7da2216f8293c2e8d6eb1`

**Live Kiro qualification:** `NOT CLAIMED` — this source remediation does not substitute for the separate owner-host/provider runtime qualification.

## Finding

The owner-approved ODR-2 policy had not been implemented in the accepted A8 R1 source. Durable `agent_sessions` rows were bound only to principal/project/backend/profile and provider state. They did not record the committed source revision the provider conversation last observed. Resume reservation therefore could not distinguish an `implement` continuation on unchanged source from a continuation after source drift.

Per-job `baseCommit` did not close this gap because it was captured for the new job after resume admission and was artifact/apply provenance, not durable provider-session continuity authority.

## Locked policy

ODR-2 uses the owner-selected hybrid policy:

- `implement` / mutating resume requires the prior session to carry a trusted 40-hex source revision and the freshly staged current revision to match exactly;
- revision drift or a legacy unbound session fails closed with `SESSION_NOT_RESUMABLE` before credentials or persisted provider state are restored;
- `audit`, `plan`, and `review` may continue across revision drift only after trusted staging has freshly attested the current committed revision;
- read-only provider memory is context only. It never becomes permission, filesystem truth, apply authority, or a substitute for the freshly staged source;
- a successful turn creates its successor session with the trusted `baseCommit` returned from the staged workspace, so continuity advances to the source revision actually observed by that turn.

## Durable schema

`AGENT_JOB_SCHEMA_VERSION` advances from v8 to v9.

v9 adds exactly one provenance field to `agent_sessions`:

```text
source_revision TEXT NULL
```

Migration is additive and provenance-preserving:

- genuine v8 rows migrate with `source_revision = NULL`; no revision is inferred from current source;
- a legacy NULL session may be resumed only by a read-only profile after fresh source attestation;
- mutating resume from a legacy NULL session fails closed;
- any pre-v9 database already containing the v9 column is rejected as partial/out-of-tree migration state rather than silently adopted;
- current-schema shape validation requires the v9 column and stored non-NULL revisions are validated as exact 40-hex Git commits when read.

## Enforcement boundary

Kiro `prepare()` already performs trusted workspace staging before credential provisioning, provider-state restoration, egress setup, or provider execution. ODR-2 reuses that existing authority boundary instead of adding a second Git path.

The sequence is:

```text
trusted project mapping
  -> trusted staging of committed HEAD
  -> obtain staged baseCommit
  -> ODR-2 revision check
  -> credential provisioning
  -> provider-state restoration
  -> provider execution
```

For a mutating resumed session, drift therefore stops before provider state can observe the new source.

## Red-before-fix evidence

A dedicated regression file was added before production mutation:

`tests/unit/a8-odr2-source-revision.test.ts`

The initial run against the accepted base failed **5/5** assertions for the intended reasons:

- session source revision was not persisted;
- durable schema was still v8;
- no writer-drift denial primitive existed;
- no read-only context-only drift disposition existed;
- no legacy-unbound writer denial existed.

## Candidate qualification

Pre-freeze source qualification after remediation:

```text
ODR-2/A8/store focused matrix:
5 files / 182 PASS / 0 FAIL

Full unit:
149 files / 3086 PASS / 0 FAIL

typecheck:
PASS

build:
PASS

authority invariants:
16 / 16 PASS
10 Compose files / 7 Dockerfiles

fixed-seed security fuzz:
seed 1374718481
15 targets
30067 executions
395 coverage ranges
PASS

git diff --check:
PASS
```

Focused regression coverage additionally proves:

- genuine v8 -> v9 migration leaves historical session revision NULL;
- a v8 stamp carrying premature v9 state fails closed without restamping;
- successful engine completion persists the trusted `baseCommit` on the ACTIVE successor session;
- mutating Kiro drift is rejected immediately after staging and before credential/provider-state restoration;
- read-only drift passes the ODR-2 boundary only as `DRIFT_ALLOWED_CONTEXT_ONLY` after fresh staging.

## Not claimed

This remediation does not claim live Kiro `session/load` qualification, owner-host deployment, Docker/provider availability, or production release acceptance. Those remain separate external/runtime gates and must be evidenced on the exact promoted revision.
