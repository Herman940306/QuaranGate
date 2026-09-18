# SH-04 — First Enterprise Identity Provider Selection

**Date:** 2026-09-18
**Status:** `OWNER_DECISION_CLOSED / IMPLEMENTATION_NOT_STARTED / LIVE_QUALIFICATION_NOT_RUN`
**Decision authority:** Herman / owner, executed under the standing autonomous-governance instruction to make the best documented owner decision when a non-destructive decision gate is otherwise blocking progress.
**Source baseline:** `86d46c022453005f9c69016e569cc339d0174210`

## Decision

QuaranGate's **first enterprise identity provider profile is Microsoft Entra ID**.

The product contract is **not Microsoft-specific authentication code**. The implementation boundary is a **generic OpenID Connect (OIDC) federation interface**, with Microsoft Entra ID as the first provider profile that must be implemented and qualified.

Initial protocol direction:

- OpenID Connect discovery from one explicitly configured issuer;
- OAuth 2.0 Authorization Code flow with PKCE;
- exact redirect URI binding;
- exact issuer and audience validation;
- nonce and state binding;
- signature validation through the provider's published JWKS;
- bounded key-rotation handling;
- no implicit-flow fallback;
- no SAML implementation in the first enterprise-IdP slice;
- no dynamic provider discovery from user-controlled request data.

## Authorization boundary

External IdP identity is **authentication evidence only**.

QuaranGate remains the sole authority for:

- principal identity used by the gateway;
- scopes;
- target grants;
- Agent project/backend/profile grants;
- GitHub account/project grants;
- rate-limit identity;
- IDE/session/controller/writer authority.

IdP roles, groups, email addresses, display names, tenant roles, directory roles, or arbitrary token claims must **not** automatically become QuaranGate permissions.

The future federation implementation must use an explicit owner-managed mapping from a verified external identity to an existing QuaranGate principal. A missing, ambiguous, disabled, stale, or multiply mapped identity must fail closed.

## External identity key

The generic security identity is the exact tuple:

```text
verified issuer
+ verified subject
```

Provider-specific convenience claims may be recorded only as bounded non-authoritative metadata where needed for operator review.

For the first Entra profile, tenant binding must be explicit. Multi-tenant or `common`-authority behavior is not accepted by default for enterprise authorization.

## Relationship to the existing QuaranGate OAuth facade

The current QuaranGate OAuth 2.1 facade remains the authorization server presented to MCP/browser clients.

Enterprise OIDC is intended to replace the human API-key proof step at the authorization-consent boundary when that deployment explicitly enables enterprise federation. It does **not** replace:

- MCP client registration;
- MCP resource binding;
- QuaranGate authorization-code issuance;
- MCP PKCE validation;
- QuaranGate access/refresh-token rotation;
- QuaranGate principal/scope enforcement.

There must be no silent downgrade from configured enterprise federation to API-key consent if the enterprise provider is unavailable or invalid. Any local-break-glass path, if later approved, requires a separate explicit owner policy and cannot be inferred from this decision.

## Egress and secret boundary

This decision does not authorize new gateway egress by itself.

A later implementation must reconcile external IdP discovery/token/JWKS traffic with the accepted SH-10 egress/SSRF model before live use. Provider endpoints must be derived only from an explicitly trusted issuer/discovery configuration and subjected to bounded scheme/host/address validation appropriate to the gateway trust model.

Client credentials, if the chosen Entra application type requires them, must be provided through the existing secret-governance approach and must never be committed, logged, written into ordinary evidence, or accepted from browser request data.

## Why Entra first

The first enterprise profile is Entra because it is a standards-based OIDC provider with tenant-scoped discovery, authorization, token and JWKS endpoints, supports Authorization Code + PKCE, and is a natural first qualification target for Windows-centric enterprise deployments.

The generic OIDC boundary deliberately preserves compatibility with other standards-compliant providers such as Okta and Keycloak without making either one an implicit fallback or qualified provider.

## Acceptance of this gate

SH-04 closes only the previously recorded **owner-selection decision**.

Accepted claim:

`SH04_IDP_SELECTION=MICROSOFT_ENTRA_ID / GENERIC_OIDC_CONTRACT`

Not accepted or inferred:

- Entra application registration;
- tenant/client identifiers;
- provider credentials;
- live OIDC discovery;
- live token exchange;
- JWKS retrieval/rotation;
- external identity-to-principal mapping implementation;
- gateway egress expansion;
- SSO deployment;
- conditional-access qualification;
- MFA-policy qualification;
- IdP outage/recovery qualification;
- production authentication acceptance;
- any change to QuaranGate authorization.

Those require a separately scoped source implementation and live qualification against the exact then-current canonical revision.
