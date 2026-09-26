# BE1-R2 Product Identity / Session Foundation Handoff

## Scope

Source-only BE1 foundation in the owner-selected internal Next.js product application service.

Base: `5fc68fe23918dfca764a3b5e6de8eb73ede2167c`
Base tree: `3a490302868c035460fe730f19cce30ca647243b`

No runtime deployment, Keycloak instance, Entra credential, PostgreSQL, OpenBao, gateway routing, listener, port, MCP authority, push, merge, or deploy is part of this candidate.

## Canonical namespaces

Server:
`frontend/src/server/product/**`

API:
`frontend/src/app/api/product/**`

Exactly five handlers:
- `GET /api/product/auth/login`
- `GET /api/product/auth/callback`
- `GET /api/product/session/current`
- `POST /api/product/session/workspace`
- `POST /api/product/session/logout`

No sibling BE1 implementation exists under `src/server/auth`, `identity`, `session`, or `authority`.

## Implemented

- standards-based OIDC Authorization Code foundation using `openid-client`;
- PKCE S256, state and nonce generation/validation boundary;
- discovery from configured issuer and client-id/audience validation through the OIDC library;
- callback identity establishment with expiry/subject checks;
- server-held access/refresh/ID-token custody;
- opaque HttpOnly product-session cookie; Secure in production; SameSite=Lax; bounded Path;
- explicitly non-production, replaceable in-memory session store that refuses production;
- non-production workspace-membership adapter that refuses production;
- session versioning and workspace-switch stale-write rejection;
- synchronized session CSRF token, constant-time comparison, same-origin/cross-site checks;
- local logout plus best-effort provider token revocation;
- typed principal-mapping boundary: unmapped/mapped-reference/unavailable/forbidden;
- bounded browser-safe error model and allow-listed identity audit events;
- safe federation-provider metadata only.

## Security boundary

Product identity never creates QuaranGate operational grants. A mapped principal reference does not expose or synthesize scopes, target grants, project/backend/profile grants, GitHub authority, Docker/host authority, or writer leases.

Browser-visible session data excludes OIDC tokens. Audit/error tests assert representative token/PKCE/host-path material is absent.

## Dependencies

- `openid-client@6.8.8`, MIT
- `server-only@0.0.1`, MIT
- locked transitive additions: `jose@6.2.12` MIT; `oauth4webapi@3.8.8` MIT

Final npm audit: zero vulnerabilities.

## Validation

Passed before freeze:
- `npm run typecheck`
- `npm run lint`
- BE1 focused Vitest: 24/24
- full frontend Vitest: 31/31
- `npm run build` (five BE1 dynamic routes present)
- `npm audit --audit-level=high`: 0 vulnerabilities
- bounded secret-shape scan
- namespace/route-count/ownership checks
- `git diff --check`

The Next build rewrites tracked `frontend/next-env.d.ts`; that generated change was restored exactly from the base and is not part of BE1.

## Collision recovery

The incident receipt and recovery rules are in `BE1_COLLISION_RECOVERY.md`. No source code was copied from the contaminated worktree. Its HEAD and dirty-status digest remained unchanged during R2 work.

## Known limitations / future owners

- No PostgreSQL durability: BE2.
- No final product-user → QuaranGate Principal mapping: BE3.
- No live Keycloak or Entra integration/credential qualification.
- No multi-instance session durability.
- No durable organization/workspace membership model.
- No gateway/reverse-proxy deployment change.
- No operational capability execution from product identity.

## Review

This is a candidate handoff only. Independent/orchestrator review must derive acceptance from the immutable candidate and direct evidence; this document does not self-accept BE1.
