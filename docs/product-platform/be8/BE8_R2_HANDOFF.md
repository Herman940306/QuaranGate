# BE8 R2 Security-Boundary Closure Handoff

Role: implementation lead only. This candidate is not self-accepted.

## Base

- BE8 R1 candidate: `4af79ab59b34afeb4feec5af401c6823d95c49f0`
- R1 tree: `eaeaac4aa59932f7cb38a196dd6b2a4df557a136`

## Independent follow-up findings closed

R2 closes two additional authority defects found during review of R1:

1. Security discovery and plan POST routes did not invoke the product CSRF/origin guard.
2. Deterministic discovery IDs were derived only from source snapshot data, so identical snapshots across tenants could collide in the shared in-process discovery store and overwrite each other.

## Remediation

- `POST /api/product/security/discovery/start` now calls `assertCsrf(request, session)` before parsing or discovery.
- `POST /api/product/security/plan` now calls `assertCsrf(request, session)` before plan lookup.
- Server-owned discovery IDs are re-scoped with authenticated product-user, organization, workspace and Principal identity plus the source-level discovery identity.
- Identical source snapshots under distinct tenant/user authority now produce distinct public discovery IDs and cannot overwrite one another in the bounded store.
- Existing R1 workspace membership, Principal refresh, trusted source adapter, server-owned result store, plan-by-ID, source revision authority and static byte/file/path limits are preserved.
- Source/governed-document diff checks pass. Whole-staged diff-check remains nonzero only because preserved raw tool-output receipts contain terminal/CRLF trailing whitespace; those receipts are retained byte-for-byte as execution evidence rather than rewritten cosmetically.

## Disclosed integration gap

The default production `SecuritySourceAdapter` remains deliberately unavailable/fail-closed until a governed registered-project source adapter is wired. Tests use explicit trusted adapters. No host-path or caller-file fallback was added.

## Acceptance boundary

R2 requires an independent read-only review. Do not integrate BE8 and do not start BE9 until R2 passes, BE8 is integrated into the backend convergence line, the new convergence candidate passes combined validation, and that convergence candidate receives independent review.
