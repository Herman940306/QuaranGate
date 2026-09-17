# SH-15 Operational Security Closure

Status: **SOURCE CANDIDATE QUALIFIED / STRICT SELF-AUDIT PENDING**

Base: `566f264109f56bef55d72fbc982fe7d7dd4fa3af` (`docs(sh14): prepare external pentest package`)

SH-15 closes only the nondependent, product-controlled operational-security scope. It does **not** claim that SH-14 external penetration testing occurred, that external provider/IDE/IdP prerequisites are available, or that the current forward source is deployed.

## Scope

The gate reconciles secure defaults, operational secrets, rotation/revocation, audit integrity, recovery, backup/restore boundaries, incident handling, least privilege, service lifecycle, deployment/runbook truth, known limitations, enterprise operating assumptions and release-evidence requirements.

## Findings and remediation

### SH15-F1 — Kiro credential path accepted symlink/replacement races

The Kiro credential manager used a following `stat()` plus path-based read. A credential path could therefore be a symlink, and metadata validation was not cryptographically or inode-bound to the opened file.

Remediation:

- use `lstat()` and require a regular file;
- open with `O_NOFOLLOW`;
- compare the opened descriptor identity to the pre-open `lstat()` device/inode;
- revalidate mode/size on the descriptor;
- reject multiline/NUL framing and wrap raw filesystem diagnostics.

### SH15-F2 — Kiro secret/resource cleanup could be reported as successful when deletion failed

Credential revocation, ordinary Kiro backend cleanup, provider-state invalidation and workspace disposal included best-effort deletion paths that could clear tracked handles or continue processing despite an unverified security-resource deletion.

Remediation:

- credential revocation retries and then fails closed with bounded/sanitized error text;
- Kiro cleanup retains handles whose deletion is unverified and cannot log `cleanup complete` after a failed cleanup;
- provider-state invalidation propagates deletion failure;
- workspace disposal propagates removal failure;
- the job engine stops claiming new work after unverified security cleanup while preserving the original terminal job/session authority semantics.

### SH15-F3 — Docker-authority broker reused the ordinary internal-service credential

The broker/server/client accepted `INTERNAL_TOKEN` as a fallback for `DOCKER_AUTHORITY_TOKEN`; Compose also provisioned the same value into both trust boundaries. This made compromise of the gateway↔executor credential automatically sufficient for executor↔raw-Docker broker authentication.

Remediation:

- remove all `INTERNAL_TOKEN` fallback from Docker-authority client/server;
- require `DOCKER_AUTHORITY_TOKEN` explicitly in production Compose;
- reject equality with `INTERNAL_TOKEN` at the executor broker client;
- add a static authority invariant so missing/fallback/reused broker credentials fail the security gate;
- update `.env.example` and operator guidance to require independently generated values.

### SH15-F4 — gateway audit stream had no tamper-evident ordering primitive

The bounded in-memory activity view and stdout JSON audit records had redaction and attribution, but no mechanism to detect deletion, reordering or mutation in a captured stream.

Remediation:

- add `SHA256_CHAIN_V1` per-process audit records with `streamId`, monotonic `sequence`, `previousHash` and `entryHash`;
- expose only the bounded current chain head/state through the authenticated Control Center activity view;
- explicitly document that this is not a signature, durable store or defense against a fully compromised gateway;
- require an access-controlled append-only/immutable external collector and independent chain-head anchoring for enterprise retention.

### SH15-F5 — GitHub temporary installation-token cleanup could false-success

`pushBranch()` removed its temporary secret volume with swallowed errors and could return success even when the installation-token volume remained. Startup orphan reconciliation similarly converted enumeration/removal failures into empty/success counts.

Remediation:

- push completion fails closed if helper-container or temporary secret-volume deletion cannot be verified;
- cleanup still attempts every known temporary resource before returning the generic failure;
- startup GitHub orphan inventory/removal errors propagate;
- returned orphan counts represent confirmed removals only;
- raw Docker/provider diagnostics are not copied into the public cleanup failure.

### SH15-F6 — current operator/capability documentation drifted from accepted architecture

Several current guidance surfaces still stated that the executor owned the raw Docker socket and exposed obsolete phase labels/SHA/test-count claims as current. Control Center capability labels also described Copilot/IDE source as not integrated/not started even though accepted forward source had advanced.

Remediation:

- current README, architecture, operations, remote-owner and client guidance now reflect broker-only raw Docker authority;
- moving source acceptance is delegated to immutable audit/control receipts instead of stale runbook SHAs/test counts;
- source capability state and live/deployed qualification state are presented separately in Control Center;
- historical audit receipts remain untouched as historical evidence.

## Operational-security runbooks

Added:

- `docs/security/OPERATIONAL_SECURITY.md`
- `docs/operations/INCIDENT_RESPONSE.md`

They define secure defaults, credential separation and rotation, audit-chain limitations/retention, backup/restore rules, fail-closed cleanup/recovery, incident response, least privilege, exact-source deployment truth, known external gates and release-evidence requirements.

## External/live truth intentionally left open

This source gate does not convert any external prerequisite into PASS:

- SH-14 independent external pentest execution/retest: **BLOCKED_EXTERNAL**;
- SH-03 MCP SDK/protocol artifact migration: **BLOCKED_EXTERNAL_ARTIFACT**;
- SH-04 enterprise IdP selection: **OWNER_DECISION_GATED**;
- provider live qualification where entitlement/subscription is unavailable: **DEFERRED/EXTERNAL**;
- VS Code/Cursor final live qualification: remains the separately recorded live/runtime state;
- owner-host recovery/deployment gates: remain owner-host/live gates;
- full release assurance: remains blocked wherever required integration/E2E/scanner/image/provenance inputs are unavailable.

No external finding is claimed closed because no external SH-14 execution occurred.

## Qualification on final source logic before immutable freeze

- focused/widened SH-15/security regressions: PASS;
- full unit corpus: **148/148 files, 3059/3059 tests PASS**;
- TypeScript typecheck: PASS;
- source build: PASS;
- `git diff --check`: PASS;
- authority/security invariants: **16/16 PASS** across 10 Compose files and 7 Dockerfiles;
- deterministic security fuzz: **PASS**, seed `1374718481`, 15 targets, **30067 executions**, **395 coverage ranges**.

The immutable commit/tree/patch/path/content receipts are recorded only after final-byte freeze. The owner-authorized strict self-audit must reproduce them before canonical integration. This review mode is not independent review.
