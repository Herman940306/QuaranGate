# BE9.2 R1 — durable assessment platform freeze handoff

Status: `CANDIDATE_READY_FOR_FREEZE / NOT_SELF_ACCEPTED`

Accepted BE9.1 base:

```text
5be680eae9f492d36092abbe3f461a4fa6d70ff0
tree 08129d02c9a40cac2ba45ba8e81f34296b27e935
```

BE9.2 implementation parent:

```text
009d8783a830ed3319d779965bba37ea44f8539f
tree 8a9cd2aa8ac67d189aadc766af9bac6bb66f46c1
subject feat(be9): implement durable assessment admission platform
```

The parent was frozen by another implementation writer while this continuation was independently qualifying the same dirty BE9.2 worktree. It has **not** been independently accepted. Therefore the next reviewer MUST review the final cumulative BE9.2 R1 candidate from accepted BE9.1 base `5be680e...`, not merely this R1 delta.

## Cumulative BE9.2 implementation

The cumulative candidate provides:

- exact-revision source staging with independent live-source and staged-byte truth;
- immutable closed staging receipts and pre-RUNNING staged-volume revalidation;
- durable PostgreSQL BE8 discovery, BE9 assessment lifecycle, transition journal, admission receipt and evidence metadata;
- durable restart-safe prepared-resource metadata and replay ledger;
- shared BE1A execution-resource leases for agent jobs and security assessments;
- assessment-specific bounded Docker Authority operations without raw Docker exposure;
- narrow product -> Gateway operational admission bridge;
- product assessment API:
  - `POST /api/product/security/assessments`
  - `GET /api/product/security/assessments/[id]`
  - `GET /api/product/security/assessments/[id]/evidence`
  - `POST /api/product/security/assessments/[id]/cancel`
- MCP assessment tools:
  - `security_assessment_start`
  - `security_assessment_status`
  - `security_assessment_cancel`
  - `security_assessment_evidence`
- shared durable assessment service semantics across product HTTP and MCP adapters;
- dedicated assessment bridge/MCP credentials with fail-closed token separation;
- BE10 scanner capability truthfully unavailable.

## R1 remediation on top of 009d878

This bounded R1 closes three freeze-time integrity findings without expanding authority:

1. restores generated `frontend/next-env.d.ts` build drift to the accepted source form;
2. runtime-validates durable assessment `assessmentIntent` rather than trusting a TypeScript cast on reload;
3. cross-binds durable discovery row `project_id` / `target_id` to the immutable discovery snapshot, preventing DB-column/snapshot identity drift.

Regression coverage proves invalid durable intent and discovery column/snapshot drift fail closed.

## Qualification

Fresh cumulative qualification is recorded in
`docs/product-platform/be9/evidence/BE9_2_R1/VALIDATION.txt`.

Highlights:

- BE9/BE8/product focused: 5 files / 123 tests PASS;
- BE9 operational + BE1A + AgentJobStore focused: 11 files / 175 tests PASS;
- frontend full: 21 files / 324 tests PASS;
- root full: 183 files / 3457 tests PASS;
- root/frontend typecheck PASS;
- root/frontend production build PASS;
- frontend lint PASS, 171 files, zero warnings;
- security invariants PASS, 16 rules / 12 compose / 7 Dockerfiles;
- security fuzz PASS, 15 targets / 30,067 executions;
- root/frontend npm audit: 0 vulnerabilities;
- `git diff --check`: PASS;
- bounded high-signal changed-line secret scan: 0 findings.

External owner-provided security toolchain remains honestly classified:

```text
SECURITY_TOOLCHAIN=BLOCKED_ENVIRONMENT
ABSENT=semgrep@1.177.0,gitleaks@8.30.0,osv-scanner@2.6.0,trivy@0.74.0,cosign@3.1.3
AUTO_DOWNLOAD=FORBIDDEN
```

## Review boundary

The implementation writer does not self-accept.

The independent reviewer must validate the **full cumulative BE9.2 candidate** against the frozen BE9 contracts and accepted BE9.1 base. A PASS must not imply BE10 scanner execution exists or that blocked owner-provided external tools ran.

```text
BE9_2_ACCEPTED=NO
SELF_ACCEPTANCE=NO
BE10_START_ALLOWED=NO_UNTIL_INDEPENDENT_BE9_2_PASS_AND_ORCHESTRATION_GATE
NEXT=STRICT_INDEPENDENT_READ_ONLY_REVIEW
```
