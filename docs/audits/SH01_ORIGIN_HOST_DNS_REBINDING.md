# SH-01 Origin / Host / DNS-Rebinding Hardening

## Status

`SOURCE_CANDIDATE_IMPLEMENTED / LIVE_DEPLOYMENT_NOT_RUN`

This gate hardens the public gateway request boundary. It does not change executor,
Docker, provider, filesystem, IDE, GitHub, OAuth-principal or lifecycle authority.

## Threat model

The gateway is intentionally published only through a host-loopback Docker binding,
with approved remote HTTPS ingress terminating in front of that loopback endpoint.
A browser can nevertheless reach loopback services, and DNS rebinding can cause an
attacker-controlled hostname to resolve to a local address. Browser requests can
also carry hostile `Origin` values while server-side MCP clients normally carry no
Origin at all.

SH-01 therefore treats request authority as an independent admission boundary before
telemetry, OAuth, Console, authentication or MCP route handling.

## Frozen source contract

`BRIDGE_PUBLIC_URL` is an origin, not a path base. Startup fails closed unless it is:

- absolute HTTP(S);
- free of userinfo, query, fragment and non-root path;
- HTTPS for every non-loopback origin;
- accompanied by an integer `BRIDGE_PORT` in the valid TCP port range.

Every HTTP request must then satisfy:

1. exactly one raw `Host` header when Node exposes raw headers;
2. a syntactically canonical Host authority;
3. Host equality with either the configured public authority (including equivalent
   explicit default port) or one exact loopback authority on the configured gateway
   port;
4. zero or one raw `Origin` header;
5. when Origin exists, an exact operator-approved browser origin compatible with the
   admitted Host.

The public browser origin is also accepted when an approved reverse proxy rewrites
Host to the exact loopback upstream authority. This preserves the existing HTTPS
Funnel -> loopback architecture without trusting `X-Forwarded-Host`, `Forwarded`, or
any other caller-controlled forwarding metadata.

Local browser origins remain tied to their exact local Host/port. `Origin: null`,
cross-origin values, malformed/multiple Origins, arbitrary Host aliases, trailing-dot
hosts, userinfo, path-bearing Host values, invalid ports, unbracketed IPv6 and
non-loopback IPv6 literals are refused.

## Failure behavior

- Host/authority failure: HTTP 421 with generic `request authority rejected`.
- Origin failure: HTTP 403 with generic `request origin rejected`.
- Rejections are `Cache-Control: no-store` and do not disclose the allowlist.
- Admission occurs before request telemetry and before any credential parsing.

No CORS allowlist is introduced. Server-side MCP clients remain compatible because
an absent Origin is valid after Host admission. Browser cross-origin API access
remains denied.

## Adversarial coverage

Permanent tests prove:

- exact public Host works with server-side MCP traffic that carries no Origin;
- public authority with explicit default HTTPS port is equivalent;
- exact public same-origin browser requests work;
- hostile browser Origin is denied without allowlist disclosure;
- DNS-rebinding Host is denied even when `X-Forwarded-Host` claims the public host;
- duplicate raw Host cannot normalize into success;
- exact loopback operational Host works only at the configured gateway port;
- local Origin/Host aliases cannot be mixed cross-origin;
- public Origin survives an approved reverse-proxy loopback Host rewrite;
- malformed, dotted, smuggled and arbitrary IPv6 authorities are denied;
- non-loopback plaintext `BRIDGE_PUBLIC_URL` is denied at startup;
- path/userinfo-bearing public URL is denied;
- invalid gateway port is denied;
- approved Origin alone cannot rescue an unapproved Host.

## Validation

Validation on the final pre-freeze source bytes:

- focused gateway/OAuth/Console matrix: `62/62 PASS across 7/7 files`;
- repository full unit corpus: `2762/2762 PASS across 107/107 files`;
- TypeScript typecheck: PASS;
- build: PASS;
- `git diff --check`: PASS;
- exact seven-path secret scan: `0 findings`;
- source authority/network delta scan: PASS;
- middleware-order audit: request admission is mounted before telemetry, health/readiness, OAuth, Console, authentication and MCP route handling.

Immutable source receipts are recorded at the freeze/acceptance gate rather than
inferred from mutable working bytes.

## Deployment boundary

This source gate does not change the existing Funnel configuration, publish a new
port, alter Docker bindings, add a proxy trust setting or deploy/restart production.
Live ingress qualification remains a later bounded runtime gate.

## Owner-authorized source acceptance receipt

Verdict: `OWNER_AUTHORIZED_SELF_AUDIT_PASS / SH01_SOURCE_ACCEPTED`.

This is a source acceptance under the owner's standing strict self-audit exception; it is deliberately not represented as independent review and it does not claim live ingress deployment qualification.

Immutable implementation source:

- commit: `1808db1e27ffb473b5d6f5d64daea2eb24d4086b`;
- parent: `5974e69171dad9a76885e5044b4959f99d387f13`;
- subject: `fix(security): enforce gateway host origin admission`;
- patch SHA-256: `7595a8aff9fc1983d19741dab6a4160e978b4fe484a4f5400c7ea4a076372120`;
- path/status SHA-256: `20ead458c803d98c32a7a79dcf3d4c3718ed8a1693d1e90a8f023349982f9d4f`;
- content-manifest SHA-256: `ffe1cf8d3cb313e57230902c4e5baca7d57fec9abd4a2f5c80ddbd58c712dc87`;
- implementation path count: `7`.

Immutable replay: focused `62/62`; repository unit `2762/2762` across `107/107`; typecheck/build/diff-check PASS; seven-path secret scan `0 findings`; worktree clean and staging empty after temporary dependency symlink removal.
