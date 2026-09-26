# BE1-R2 Server Dependency Review

Registry metadata and installed lockfile reviewed 2026-09-26.

| Dependency | Exact version | License | Purpose |
|---|---:|---|---|
| `openid-client` | 6.8.8 | MIT | Standards-based OpenID Connect/OAuth client for discovery, Authorization Code + PKCE, state/nonce validation, ID-token issuer/audience/signature/time validation, and token revocation. Avoids custom JWT/OIDC cryptography. |
| `server-only` | 0.0.1 | MIT | Marker package used by Next.js server compilation to prevent BE1 credential/session modules from being imported into client component graphs. |

Locked transitive packages introduced by `openid-client`: `jose@6.2.12` (MIT) and `oauth4webapi@3.8.8` (MIT).

No CDN/runtime browser dependency is introduced. `npm audit --audit-level=high` reported zero vulnerabilities during implementation; final candidate evidence records the repeated result.
