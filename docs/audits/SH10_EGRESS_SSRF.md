# SH-10 SSRF / Egress Security Hardening

## Scope

SH-10 hardens QuaranGate's bounded outbound Internet path without adding any
new network, Docker, host, provider, filesystem or process authority. The
existing architecture is preserved:

- agent runner containers remain on internal-only Docker networks;
- only the dedicated egress-proxy container is connected to the external
  network;
- runners receive explicit proxy environment variables and an empty
  `NO_PROXY` value;
- CONNECT remains restricted to TCP port 443;
- admission uses exact owner/product-approved hostnames;
- DNS is resolved before dialing and the proxy connects to the validated IP,
  not the hostname, so the connect path does not perform a second DNS lookup.

The gate is source/security qualification only. It does not claim live provider
availability, owner-network certification, enterprise perimeter certification,
or P10/P11 production qualification.

## Findings remediated

### SH10-F1 — incomplete special-use / non-global IP denial

The former `isPrivateAddress()` implementation blocked common RFC1918,
loopback and link-local ranges but did not comprehensively reject special-use,
multicast, documentation, shared-address, transition or malformed resolver
outputs. Examples include CGNAT, multicast/reserved IPv4, IPv4-mapped IPv6,
NAT64, Teredo and 6to4 forms.

Remediation:

- centralize exact-hostname and IP policy in `src/shared/egressPolicy.ts`;
- reject malformed/non-IP resolver values fail closed;
- maintain separate IPv4 and IPv6 `net.BlockList` instances to avoid family
  cross-normalization surprises;
- deny fixed non-global/special-use ranges before any upstream dial;
- validate every DNS answer, not just the selected address;
- require reported DNS family to match the syntactic IP family;
- bound DNS resolution time and reject empty result sets.

### SH10-F2 — explicit empty exact allowlist could fall back to defaults

`EgressProxy({ allowedHosts: [] })` and an explicitly present but empty
`EGRESS_PROXY_EXACT_ALLOWLIST` could be interpreted as "use defaults". That is
unsafe for a replacement/owner-approved allowlist because empty policy must
mean deny/fail, never broaden authority.

Remediation:

- constructor semantics now distinguish `undefined` from an explicitly empty
  replacement list;
- an explicit empty list produces a deny-all proxy;
- an explicitly present empty `EGRESS_PROXY_EXACT_ALLOWLIST` is invalid startup
  configuration;
- exact and additive allowlist environment forms cannot be combined.

### SH10-F3 — exact hostname grammar was weaker than the authority intent

Trusted egress names could be normalized only by trim/lowercase in some paths.
SH-10 now uses one exact hostname grammar for proxy and Copilot configuration:

- ASCII DNS label grammar only;
- multi-label fully-qualified names only;
- no IP literals, userinfo, ports, surrounding whitespace, trailing dot,
  empty labels, raw Unicode ambiguity, or leading/trailing label hyphens;
- canonical lower-case representation and deterministic de-duplication.

### SH10-F4 — CONNECT preamble and early tunnel bytes were not byte-exact

The previous connection parser accumulated a string request preamble. SH-10
moves admission to bounded `Buffer` handling:

- complete CONNECT preamble including terminating `CRLFCRLF` is capped at
  8192 bytes;
- early tunnel data in the same TCP receive is preserved and capped at 64 KiB;
- the client socket is paused while DNS/upstream connect is pending;
- upstream connect has a 15-second timeout;
- the validated/pinned IP is the only upstream dial target.

A regression specifically proves the four-byte CONNECT terminator is included
in the header budget.

## Dedicated release gate

SH-10 adds mandatory release gate `security-egress`:

- fixed command identity: `vitest-security-egress`;
- fixed corpus: `tests/unit/sh10`;
- exact source binding through the existing release receipt machinery;
- nonzero passing test count required;
- failed/skipped/todo evidence cannot satisfy the release policy;
- the gate is included in release assurance, release security policy and final
  evidence-bundle validation.

The mandatory release-gate count becomes 16.

## Validation before immutable freeze

The mutable candidate completed:

- dedicated `security-egress`: PASS;
- adjacent provider/GitHub/release-policy matrix: `273/273` PASS;
- full unit suite after final header-bound remediation: `140/140 files`,
  `2957/2957 tests` PASS;
- TypeScript typecheck: PASS;
- TypeScript build: PASS;
- `security:invariants`: `15/15` PASS;
- SH-08 `security-fuzz`: `15` targets / `30067` executions / `395` covered
  ranges PASS;
- SH-09 crash/chaos fixed corpus: `2/2 files`, `14/14` tests PASS;
- `git diff --check`: PASS;
- `/tmp/q`: absent after validation;
- cgroup `oom_kill`: `17 -> 17`.

The final immutable candidate must reproduce these applicable gates before
source acceptance.

## Authority / integrity audit

Pre-freeze audit confirms:

- no dependency or package-lock change;
- no Docker socket/API, published-port, privilege, capability, host-network,
  filesystem or provider authority expansion;
- runner/external-network topology is unchanged;
- no changed test uses `.skip`, `.todo` or `.only` weakening;
- release policy contains 16 unique required gates including
  `security-egress`;
- external GitHub governance work remains a separate owner-reported/read-only
  lane and is not part of this candidate.

## References / design rationale

The design follows the established QuaranGate fail-closed architecture and the
industry SSRF principles of exact destination allowlisting, validating all DNS
answers, rejecting private/special-use destinations, and avoiding a second
hostname resolution between validation and connection. Node's `net.BlockList`
is used only as a local fixed-subnet matcher; policy data is source-controlled
and no network lookup is required to construct the deny set.

## Non-claims

SH-10 does not claim:

- live Kiro/Copilot/GitHub provider connectivity;
- real owner-host DNS-resolver or perimeter-firewall qualification;
- hostile Docker-world qualification (SH-11);
- prompt-injection campaign (SH-12);
- IDE/same-user adversarial campaign (SH-13);
- independent external penetration test (SH-14);
- enterprise operational-security closure (SH-15);
- unavailable integration/E2E/scanner/image/provenance release gates;
- P10/A9, P11, production promotion or `v1.0.0` completion.
