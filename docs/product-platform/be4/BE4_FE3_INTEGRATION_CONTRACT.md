# BE4 FE3 Provider Integration Contract

## Status

Server-side provider/custody service and bounded same-origin HTTP integration are implemented and source-qualified.

The prior BE1 global route-count assertion was superseded by the orchestrator-approved forward-compatible invariant: BE1 auth/session namespaces remain exact and alias-free, while later product namespaces are independently bounded by their own route-contract tests. No BE1 handler or method semantic was removed or weakened.

## Bounded same-origin route contract

The installed server contract is:

- `GET /api/product/providers` — list safe providers in the current authenticated workspace.
- `POST /api/product/providers` — create provider metadata; optional `secretValue` is write-only.
- `GET /api/product/providers/{id}` — safe provider metadata for current workspace.
- `PATCH /api/product/providers/{id}` — metadata/status update with `expectedVersion`.
- `POST /api/product/providers/{id}/secret` — replace write-only secret with `secretValue` + `expectedVersion`.
- `POST /api/product/providers/{id}/validate` — bounded validation with `expectedVersion`.

There is intentionally no generic provider proxy, arbitrary URL operation, arbitrary header operation, custody-path parameter or DELETE route.

Deletion/retention policy was not accepted in BE0, so BE4 supports explicit disable rather than inventing destructive deletion semantics.

## Safe provider response

Provider reads/mutations return the existing product envelope containing only:
- id;
- organizationId;
- workspaceId;
- kind;
- displayLabel;
- optional displayHint;
- configured boolean;
- enabled/disabled status;
- validation status plus bounded code/time;
- version;
- createdAt/updatedAt.

The browser never receives `custodyRef` or secret values.

## Provider kinds

BE4 source bounds provider kinds to existing remote-provider identities:
- `kiro`
- `copilot`

No browser-supplied base URL/host is accepted.

## Mutation protection

All future mutation handlers must:
1. load the existing HttpOnly product session;
2. call existing BE1 `assertCsrf` before parsing/using mutation authority;
3. derive product user/workspace from the server session;
4. require `expectedVersion` for update/secret replacement/validation where specified;
5. delegate to `ProviderService`.

CSRF failures use the existing safe product error envelope.

## Secret semantics

`secretValue` is accepted only on create/replace mutation input.

It is passed directly to server custody handling and is never returned from:
- `ProviderService`;
- safe provider DTOs;
- audit events;
- error envelopes.

The custody reference is server-derived from authenticated tenant/provider identity and record version. FE3 must never send or retain a custody path.

## Validation states

Bounded validation states:
- `valid`
- `invalid`
- `unavailable`
- `forbidden`
- `stale`

Validation is configuration health only. `valid` does not grant MCP/ACP/target/GitHub/Docker/host authority.

## Errors

Use the existing bounded product envelope/classes. Relevant outcomes are:
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `STALE_VERSION`
- `VALIDATION_FAILED`
- `BACKEND_UNAVAILABLE`
- `INTERNAL`

Raw provider/OpenBao errors, response bodies, auth material, secret values and inaccessible tenant data are never returned.

## Current live qualification

- `LIVE_OPENBAO=UNAVAILABLE / NOT_CLAIMED`
- `LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED`
- HTTP provider route integration: source-qualified and regression-qualified in this lane; no live OpenBao/PostgreSQL qualification is implied.
