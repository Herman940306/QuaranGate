# BE1-R2 Product Identity / Session Authority Review

## Boundary and trust model

BE1-R2 runs only as server-side product code inside the internal Next.js product application service. The existing QuaranGate gateway remains the same-origin front door and governed `/mcp` operational authority path. BE1-R2 adds no listener, gateway identity logic, privileged proxy, runtime service, or operational grant source.

Human identity flows through Keycloak. A future Entra federation profile may supply identity attributes to Keycloak, but neither IdP claims nor product roles become QuaranGate scopes or resource grants. Effective operational authority remains:

`authenticated human ∩ product membership/role ∩ mapped QuaranGate Principal grants ∩ live resource preconditions`.

BE3, not BE1, owns final product-user-to-Principal mapping.

## Session binding

The browser receives only an opaque session identifier in an HttpOnly cookie. Server-side session state binds a provisional internal product-user reference, verified Keycloak subject, optional workspace context, monotonic session version, issued/expiry timestamps, correlation identity, session-bound CSRF secret, principal-mapping state/reference only, safe federation metadata, and server-held OIDC token material.

The provisional product-user reference is deterministic from verified issuer + subject only to provide a stable BE1 boundary. It is not a durable PostgreSQL product-user identity and must be replaced/adapted when BE2/BE3 establish their authoritative records.

## CSRF

All BE1 state-changing product routes require:
- a session-bound random CSRF token in `x-csrf-token`;
- constant-time token comparison;
- same-origin `Origin` validation when supplied;
- rejection of `Sec-Fetch-Site: cross-site`.

OIDC `state` protects the authorization response and is not reused as the product API CSRF token. Workspace switching also requires the current session version; stale writes fail closed.

## Token and credential custody

OIDC issuer, client id, redirect URI, optional client secret, scope, and safe federation-provider id come only from server-side configuration. Browser input cannot select issuer, token endpoint, client id, redirect URI, or provider credentials.

A maintained standards-based OIDC library performs discovery, Authorization Code processing, PKCE and OIDC/JWT validation. QuaranGate does not implement JWT signature verification or token crypto.

Access, refresh, ID token, authorization code, PKCE verifier, state, nonce, client secret, session id, and login-transaction id are never returned in browser JSON or structured audit records. OIDC token material is held only in the replaceable server-side session adapter for BE1.

## Confused-deputy prevention

A product session proves product identity only. It cannot create MCP scopes, target grants, agent project/backend/profile grants, GitHub grants, Docker/host authority, or writer leases.

The BE1 principal-mapping boundary has only four states:
- `unmapped`;
- `mapped` with a reference only;
- `unavailable`;
- `forbidden`.

No product API accepts an operational principal id or operational grants from the browser. A mapped reference is informational/relational state, never a capability token.

## Logging and redaction

Identity audit records use an explicit allow-list: event class, outcome, correlation id, provisional user reference, optional workspace reference, and bounded reason code. Provider payloads and thrown error messages are not logged directly.

Browser errors are mapped to bounded product-domain codes/messages. Raw provider errors, stack traces, host paths, cookies, credentials, tokens, authorization codes, state, nonce, and PKCE material are excluded.

## Tenancy isolation

Session lookup is by a high-entropy opaque id. Workspace switch derives the current user exclusively from the authenticated session and asks a server-side product-context adapter whether that user belongs to the requested workspace. Browser input cannot substitute another user.

BE1 has no durable workspace store. Its non-production fixture adapter is empty unless deterministically seeded by tests and refuses production use.

## Logout and revocation

Logout validates the current session and CSRF first, destroys the local product session, then makes a best-effort provider revocation of server-held refresh/access tokens. Provider-revocation failure cannot restore the local session.

A successful callback that replaces an existing product session invalidates the prior local session before returning the new cookie.

## State, nonce and PKCE

Each login attempt generates independent high-entropy state, nonce, PKCE verifier/S256 challenge, and opaque transaction id. The short-lived transaction is bound to the browser with an HttpOnly cookie. Callback processing requires and consumes that transaction once.

The OIDC library receives expected state, expected nonce, and the PKCE verifier; mismatch or omission fails authentication.

## Issuer and audience validation

Discovery begins from the configured issuer identifier, preserving issuer validation. The configured client id is the expected OIDC audience/client identity. Callback processing requires an ID token and library validation of issuer/audience, signature, time claims, nonce, state, and PKCE. BE1 additionally requires a non-empty subject and non-expired verified identity before creating a product session.

Production issuer and redirect URI must use HTTPS. Non-production HTTP is restricted to loopback.

## Account/workspace invalidation

Successful account replacement destroys the old local session. Workspace switch increments session version, rotates the CSRF secret, and atomically replaces workspace context. BE1 introduces no cross-request product-data cache.

Future caches must key at least by product user + workspace + session version and invalidate on account/workspace change.

## Non-durable adapter fail-closed rule

The BE1 in-memory session and workspace adapters are explicitly development/test-only, single-process, non-durable and non-cluster-safe. They are replaceable interfaces.

If `NODE_ENV=production`, constructing/using the memory adapter fails closed. BE1 never silently treats memory state as production persistence and never moves auth tokens to localStorage, sessionStorage or IndexedDB.

## Configuration names

Server-only logical names:
- `QG_PRODUCT_OIDC_ISSUER`
- `QG_PRODUCT_OIDC_CLIENT_ID`
- `QG_PRODUCT_OIDC_CLIENT_SECRET` (optional)
- `QG_PRODUCT_OIDC_REDIRECT_URI`
- `QG_PRODUCT_OIDC_SCOPE` (optional, defaults to `openid profile email`)
- `QG_PRODUCT_FEDERATION_PROVIDER_ID` (optional safe metadata)
- `QG_PRODUCT_SESSION_ADAPTER` (BE1 supports only explicit non-production `memory`)

No real values belong in source, tests, docs, or evidence.
