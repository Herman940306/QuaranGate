# BE3 Authority Review

## Review target

BE3 starts from accepted BE2 candidate `a3f27ce899ab633f3409c95009d9945c0ac84cd4` (tree `25b811f5a6b16d5ad51b5c8b33026af37b4e2f32`).

This review is derived from the accepted source in this worktree, not from historical summaries.

## Canonical Principal reference

The operational Principal is defined in `src/gateway/config.ts`. Its canonical identifier is `Principal.id: string`.

The same gateway-owned record also contains:
- `keyHash`;
- operational `scopes`;
- target grants;
- agent project/backend/profile grants;
- GitHub account/project grants;
- enabled state;
- optional rate limit.

BE3 must not copy those authority fields into product-owned truth.

## Current authorization boundary

API-key authentication hashes the presented credential and resolves an enabled Principal from the gateway configuration.

Gateway OAuth tokens carry a `principalId`; the gateway resolves that id back through `principalById`. MCP, ACP, GitHub and Control Center paths then apply their existing scope/resource checks and live preconditions.

Therefore a Principal id/reference is identity linkage only. Possession of a Principal reference is not operational authorization.

## Product consumption contract

The accepted product service is a separate bounded server-side Next.js service. There is no accepted shared interface by which it can read the gateway's live Principal configuration without modifying or coupling to gateway/shared authority code.

BE3 will therefore persist only a tenant-bound mapping from verified product user/context to `Principal.id`, plus mapping lifecycle metadata. It will not import `src/gateway/config.ts` into product code, parse `clients.yaml`, copy scopes/grants, or implement a parallel Principal evaluator.

A mapped product session may expose only:
- mapping state;
- Principal reference when mapped;
- mapping revision.

Future operational execution must still enter the existing gateway authorization boundary, which resolves/re-authorizes the Principal and checks current grants/preconditions.

## Mapping authority

Mapping lookup input is server-derived:
- durable product user id from verified issuer+subject;
- selected durable organization/workspace membership from BE2.

Browser-supplied Principal ids are not mapping inputs.

Product roles/memberships determine product workflow eligibility only and never create, select, or widen an operational Principal.

## Persistence boundary

A BE3 forward PostgreSQL migration may own mapping linkage metadata because it is product-to-authority-reference integration metadata. It does not own the referenced Principal or its grants.

The mapping record binds:
- product user;
- organization;
- workspace;
- Principal reference;
- lifecycle status;
- mapping revision;
- timestamps.

Absence resolves to `unmapped`. Disabled/revoked mappings resolve to `forbidden`. Repository/backend failure resolves to `unavailable`. Multiple candidate rows fail closed as unavailable/ambiguous rather than selecting one.

## Context switching and stale state

Login begins unmapped because no workspace context is selected.

Workspace switching:
1. validates BE2 durable membership;
2. resolves mapping using server-held product user + selected workspace;
3. writes the new mapping result into the new session version.

The prior session mapping is never reused across a workspace switch. Mapping revision is exposed only as safe metadata and is not a capability token.

## Audit

BE3 mapping events use the existing product audit allow-list boundary and may record correlation id, product user reference, workspace id, mapping outcome and safe Principal reference only for a successful mapped-reference result.

OIDC tokens, cookies, credentials, raw provider payloads, grant arrays and unnecessary PII are prohibited from mapping audit/error output.

## Live qualification boundary

No accepted product-to-gateway live Principal resolver exists at this base. BE3 source can prove:
- deterministic tenant-bound mapping lookup;
- no browser Principal selection;
- no grant copy/synthesis;
- fail-closed mapping lifecycle;
- session invalidation/re-resolution on context switch.

BE3 cannot truthfully claim:
- live Principal existence/enabled-state verification;
- live grant equivalence;
- runtime MCP/ACP/GitHub authorization;
- live PostgreSQL execution, because BE2 already recorded that no governed disposable PostgreSQL target was exposed.

Those remain `UNAVAILABLE / NOT CLAIMED` unless a governed prerequisite appears during this phase.
