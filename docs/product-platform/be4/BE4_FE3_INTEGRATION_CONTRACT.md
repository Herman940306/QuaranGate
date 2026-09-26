# BE4 FE3 Provider Integration Contract

## Status

Server-side provider/custody service contract is implemented and source-qualified.

HTTP route installation is **BLOCKED_INTEGRATION** in this BE4 lane because accepted BE1 test `be1-r2-route-contract.test.ts` freezes the entire `src/app/api/product/**` tree to exactly five BE1 handlers. Adding BE4 provider routes causes a mandatory accepted regression. Agent B does not own permission to rewrite that accepted test contract.

A later orchestrator/integration lane must explicitly supersede that route-count invariant before FE3 is wired.

## Intended bounded same-origin route contract

Once the BE1 route-count invariant is reconciled, the server contract is:

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
- HTTP provider route integration: `BLOCKED_INTEGRATION` pending orchestrator reconciliation of the accepted BE1 five-route invariant.
