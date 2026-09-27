# SH-04 R2 — Keycloak Broker / Entra Federation Source Contract

**Status:** `SOURCE_CANDIDATE / LIVE_QUALIFICATION_NOT_RUN`

## Contract

QuaranGate accepts one product identity broker class in this slice:

`keycloak`

The browser and external IdP never select the broker dynamically.

Production must set:

`QG_PRODUCT_IDENTITY_BROKER=keycloak`

For the first enterprise federation profile:

`QG_PRODUCT_FEDERATION_PROVIDER_ID=entra`
or the compatibility identifier:
`entra-through-keycloak`

an explicit tenant binding is required through:

`QG_PRODUCT_ENTRA_TENANT_ID`

The ambiguous Entra tenant selectors `common`, `organizations`, and `consumers` are rejected.

## Authority rule

Keycloak authenticates the product session.

Entra may contribute identity attributes to Keycloak.

Neither Keycloak roles nor Entra claims directly create QuaranGate operational grants.

Operational authority remains separately mapped and enforced by QuaranGate Principal scope/resource policy.

## Security boundary

This candidate adds no:

- external network destination;
- IdP credential;
- Docker authority;
- host path;
- browser-supplied issuer/broker;
- browser-supplied tenant;
- dynamic provider discovery;
- fallback to direct Entra authentication.

## Not proven

This source candidate does not prove that a Keycloak or Entra deployment is configured correctly or reachable. It does not close the live enterprise federation gate.
