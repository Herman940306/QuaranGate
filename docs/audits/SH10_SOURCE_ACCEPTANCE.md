# SH-10 Source Acceptance Receipt

## Verdict

`OWNER_AUTHORIZED_STRICT_SELF_AUDIT_PASS / SH10_SOURCE_ACCEPTED`

This is an owner-authorized strict self-audit of immutable source. It is not an
independent security review, live provider/network certification, external
penetration test, P10/A9 production qualification, P11 release approval, or
production promotion.

## Immutable source identity

- Canonical base: `f0e078ebd1fd7ba0bb56c3e963fba5bcc84bfcbc`
- Implementation commit: `ac20fde7ea43bddb9e684cb6a441aa170375e706`
- Implementation parent: `f0e078ebd1fd7ba0bb56c3e963fba5bcc84bfcbc`
- Subject: `security(sh10): harden outbound egress admission`
- Implementation tree: `0bc142efa449a2fd6f6f53314129cdfb7adfe6df`
- Implementation path count: `16`
- Immutable patch SHA-256: `66309b479969cf52b9ff89bba439b6ae9e344172bb4b27d5ff3831e1eec76e93`
- Content-manifest SHA-256: `f81a82f2b05b30063722fba75d6fd3d14a543cf813c976e539f208b62529f6be`

The immutable Git diff reproduces the staged candidate patch hash exactly. The
content manifest also reproduces the frozen staged binding exactly.

## Findings accepted as remediated

SH-10 closes four source-level SSRF/egress findings:

1. incomplete special-use/non-global address denial and malformed DNS-result
   handling;
2. explicit empty exact-allowlist fallback that could broaden to defaults;
3. inconsistent/weak exact hostname grammar across proxy/Copilot policy;
4. CONNECT preamble/early-data admission that was not byte-exact and lacked a
   bounded upstream-connect timeout.

The final implementation validates every DNS answer, rejects malformed/family-
mismatched and special-use results, connects only to the validated pinned IP,
uses strict exact hostname grammar, distinguishes explicit empty replacement
policy from undefined/default policy, bounds DNS/connect/header/early-data
behavior, and preserves the existing internal-runner / external-proxy network
architecture.

The final audit found and fixed an additional four-byte header-budget boundary
error before freeze: terminating `CRLFCRLF` now counts inside the 8192-byte
CONNECT preamble cap, with a dedicated regression.

## Mandatory release gate

`security-egress` is now a mandatory source-bound release gate:

- command ID: `vitest-security-egress`;
- fixed corpus: `tests/unit/sh10`;
- tool identity: Vitest `3.2.7`;
- all-passing, nonzero, zero-skip/zero-todo evidence required;
- included in release assurance, release security policy, and evidence-bundle
  validation;
- mandatory release-gate count: `16`.

The real release-receipt machinery produced `security-egress=PASS` on exact
clean source `ac20fde7ea43bddb9e684cb6a441aa170375e706`, tree
`0bc142efa449a2fd6f6f53314129cdfb7adfe6df`, with `1/1` file and `12/12`
tests passing.

## Immutable qualification

Executed against exact implementation commit
`ac20fde7ea43bddb9e684cb6a441aa170375e706`:

- full unit suite: `140/140 files`, `2957/2957 tests` PASS;
- TypeScript typecheck: PASS;
- TypeScript build: PASS;
- `security:invariants`: `15/15` PASS;
- SH-08 `security-fuzz`: `15` targets / `30067` executions / `395` covered
  code ranges PASS;
- SH-09 crash/chaos: `2/2 files`, `14/14 tests` PASS;
- SH-10 `security-egress`: `1/1 file`, `12/12 tests` PASS;
- `git diff --check`: PASS;
- `/tmp/q`: absent after validation;
- cgroup `oom_kill`: `17 -> 17`;
- no changed test contains `.skip`, `.todo` or `.only` weakening.

## Release-assurance truth

The full release-assurance orchestrator on the exact clean commit returned
`BLOCKED_ENVIRONMENT`, not PASS. Intrinsic gates including typecheck, build,
unit, authority-invariants, security-fuzz, security-chaos, security-egress and
SBOM passed. The only non-passing gates were the already-recorded unavailable
runtime/tooling inputs:

- integration: Docker CLI/runtime + `KEYS_ENV` unavailable;
- rendered E2E dependencies unavailable;
- Semgrep/Gitleaks/OSV/Trivy offline scanner inputs unavailable;
- release image inputs unavailable for image scan;
- release manifest/public key/Sigstore bundle unavailable for provenance.

No unavailable gate was represented as PASS.

## Authority / integrity conclusion

The final exact-byte audit found:

- no dependency or lockfile change;
- no Docker socket/API, host, filesystem, process, published-port, capability,
  provider or network authority expansion;
- runner network isolation remains unchanged;
- all external dialing remains behind the existing dedicated proxy/broker
  boundaries;
- release policy contains exactly 16 unique required gates;
- implementation path scope is exactly the frozen 16 paths;
- the separate owner-reported GitHub governance branch remains outside this
  candidate and unmerged.

## Non-claims

SH-10 does not claim:

- live owner-host DNS/perimeter/network certification;
- real Kiro/Copilot/GitHub provider connectivity;
- SH-11 hostile Docker-world qualification;
- SH-12 prompt-injection campaign;
- SH-13 IDE/same-user adversarial campaign;
- SH-14 independent external penetration testing;
- SH-15 enterprise operational-security closure;
- unavailable integration/E2E/scanner/image/provenance release gates;
- P10/A9 or P11 completion;
- production promotion or immutable `v1.0.0` release.
