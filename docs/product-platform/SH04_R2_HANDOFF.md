# SH-04 R2 Keycloak / Entra Source Contract Handoff

Role: implementation lead only. This candidate is not self-accepted.

## Base

Accepted backend common base:

`dae3b6bedb6f7d38481bc1de0d8bc61f0d7799e3`

## Scope

This is a source-contract slice only. It does not claim live Keycloak, Entra, SSO, egress, credentials, deployment, conditional access, MFA, or production identity acceptance.

The change binds the already-accepted product OIDC session foundation to the merged identity architecture:

```text
Microsoft Entra ID
      |
      | federation handled by Keycloak
      v
Keycloak
      |
      | product OIDC session
      v
QuaranGate product user
      |
      v
QuaranGate Principal + grants
```

## Implemented

- product identity broker is explicitly `keycloak`;
- production requires an explicit broker declaration;
- any non-Keycloak broker value fails closed;
- the first Entra federation profile requires an explicit tenant identifier;
- ambiguous Entra authorities `common`, `organizations`, and `consumers` fail closed;
- federation identifiers are bounded server configuration, not browser authority;
- existing generic OIDC issuer/client/PKCE/state/nonce/token-validation behavior remains unchanged;
- no Entra group, role, directory role, email, or arbitrary IdP claim becomes QuaranGate operational authority.

## Preserved authority

This slice does not change:

- QuaranGate Principal mapping;
- scopes;
- target grants;
- agent project/backend/profile grants;
- GitHub authority;
- Docker/host authority;
- writer leases;
- MCP OAuth semantics.

External IdP evidence remains product authentication evidence only.

## Live gaps

Still open after this source candidate:

- Keycloak deployment/composition;
- Keycloak realm/client provisioning;
- Entra application registration and federation configuration;
- live issuer discovery/token/JWKS qualification;
- product frontend/gateway deployment wiring;
- egress reconciliation for Keycloak/Entra traffic;
- credential custody and rotation;
- outage/recovery;
- MFA/Conditional Access;
- production SSO acceptance.

Independent review is required before this source candidate can be accepted or integrated.
