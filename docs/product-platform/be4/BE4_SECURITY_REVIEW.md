# BE4 Security Review

## Exact base

BE4 starts from accepted BE3 commit `23c2d531167a0e6bc070f3f39131fb026c2412a5`, tree `06ce7378b6ce6fd142ceb17ee49bec84785e6fde`.

## Accepted provider and custody contracts

BE0 freezes these boundaries:
- PostgreSQL owns provider configuration metadata and secret references, never provider secret values.
- OpenBao is the planned owner of provider credential secret values and rotation/revocation lifecycle.
- Provider Configuration Service owns safe provider definitions/metadata and validation requests/results.
- Secret values are write-only from the product API and raw secret retrieval is not a product API.
- Provider validation is not ACP/MCP authorization and cannot create operational grants.
- Product APIs use bounded envelopes/errors and optimistic version semantics.

The accepted event contract permits provider id/type plus a safe validation/error class and explicitly forbids raw secrets/credentials/provider secret values.

## Existing credential invariants

Current QuaranGate operational credential handling is reference-oriented. Existing lifecycle/installer code preserves credentials by reference or requires reauthorization and release packaging refuses secret/credential paths. These operational stores remain separate from BE4 product custody.

BE4 does not modify gateway/executor/installer authority or credential code.

## Runtime audit

No accepted OpenBao endpoint, authentication mechanism, secret-engine mount, namespace, Compose service, port or runtime deployment exists in this base.

Therefore:
- `LIVE_OPENBAO=UNAVAILABLE / NOT_CLAIMED`;
- BE4 must not invent a production mount/auth contract;
- production custody fails closed until an explicitly configured/accepted adapter is available;
- no runtime/Compose mutation is authorized in this phase.

Live PostgreSQL remains `UNAVAILABLE / NOT_CLAIMED` from BE2.

## BE4 custody namespace

Browser requests never provide a custody path/reference.

The server derives a bounded opaque custody reference from validated server-held tenant/provider identity:
`qg/product/<organizationId>/<workspaceId>/<providerId>/v<recordVersion>`.

Provider ids are server-generated UUIDs. Organization/workspace come from the authenticated product session and durable membership. Replacement writes use a new versioned reference.

## Distributed consistency

PostgreSQL and future OpenBao cannot be atomically committed as one transaction.

BE4 uses compensating semantics:
1. derive a new custody reference;
2. write secret to custody;
3. create/update metadata with expected-version checks;
4. if metadata write fails, best-effort delete the newly written custody reference;
5. after successful replacement metadata update, best-effort delete the old custody reference.

A failed metadata write never silently activates metadata pointing at the new secret. Cleanup failure is safe-orphan state, not active configuration; it is auditable without secret content.

## SSRF boundary

BE4 does not accept provider base URLs, hosts, arbitrary headers, arbitrary custody paths, or generic upstream operations from browser input.

Provider kinds are a bounded enum derived from accepted existing provider names. Validation goes through a typed server adapter. No generic network proxy is introduced.

Any future provider endpoint policy must be separately accepted before network validation is wired.

## Product authority boundary

Provider configured/valid status is product metadata only.

No provider operation:
- creates or selects a QuaranGate Principal;
- adds MCP/ACP/target/GitHub/Docker/host grants;
- widens an existing Principal;
- bypasses live QuaranGate authorization/preconditions.

Product-context eligibility is established from the authenticated session workspace and durable BE2 membership. This is not operational authority.

## Secret/log/error boundary

Resolved secret material exists only inside the custody/validator server call boundary and is never returned by provider service methods.

Safe API DTOs may expose provider id, owner scope, kind, label/hint, configured flag, status, validation status, version and timestamps. Custody references are server metadata and are intentionally omitted from browser DTOs.

Audit/error output uses bounded classes only and must never include secret values, OpenBao/provider raw responses, authorization headers, cookies, tokens or host paths.
