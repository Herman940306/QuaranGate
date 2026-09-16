# SH-08 Source Acceptance Receipt

## Verdict

`OWNER_AUTHORIZED_STRICT_SELF_AUDIT_PASS / SH08_SOURCE_ACCEPTED`

This receipt records owner-authorized strict self-audit of the immutable SH-08
source candidate. It is **not** independent review, external penetration-test
certification, live scanner certification, browser qualification, provider
qualification, P10/A9 production qualification, P11 release approval, or
production promotion.

## Immutable source identity

- Canonical base: `eece60bfa59617353ae6a2881ec3a636ee69510a`
- Implementation commit: `5831d1372b64c98ec9d7938efc7617e029a5a97b`
- Implementation parent: `eece60bfa59617353ae6a2881ec3a636ee69510a`
- Subject: `security(sh08): add bounded fuzz property gate`
- Implementation tree: `aea94b7bd2857ddacc0fae5ad0796ce2a0dbc414`
- Implementation path count: `22`
- Canonical immutable patch SHA-256: `855f6ff2cddc9113947a96880b20962cd79298e20c87bffdbb06da13a6f5a07c`
- Implementation content-manifest SHA-256: `91d57c97f7bc16e6905548e327987ca7788fc7710b702bc14e6d1b863d1488a7`

The earlier pre-commit handoff reported patch SHA-256
`0c4e2ba1856c125703d9621fc0693fc3b12846f77d0e5a2f3c90563c528c0804`.
That value is classified as a **reporting/receipt error only**, not source drift.
After commit, four independent immutable diff renderings plus a reconstructed
staged index all reproduced the canonical patch SHA-256 above. Commit, tree,
path set and per-path content hashes were unchanged.

## Accepted SH-08 properties

SH-08 source acceptance covers:

1. deterministic property/invariant tests over path confinement, guard grammar,
   archive/evidence paths, Docker image references, GitHub identities, OAuth
   resource canonicalization, redaction, IDE authenticated/handshake/remote
   frames, canonical manifests and MCP tool schemas;
2. a bounded Node/V8 precise-coverage-guided fuzz runner over 15 pure
   parser/validator targets with fixed seed, bounded input bytes, bounded corpus,
   bounded iterations and a hard elapsed-time ceiling;
3. no network, Docker, provider, host-mutation or arbitrary shell authority in
   the fuzz runner; its only child process is the local TypeScript compiler when
   the fixed `--build` gate is requested;
4. `security-fuzz` is a mandatory release-assurance gate with fixed tool identity
   `quarangate-security-fuzz` version `1`;
5. all 45 registered MCP tools now use recursively strict Zod object contracts
   for input/output objects, closing the discovered pinned-SDK behavior where
   ordinary `z.object()` silently stripped unknown properties;
6. unexpected top-level and nested output properties are rejected instead of
   being silently accepted by SDK validation;
7. no package-lock/dependency version change and no Docker/socket/network/host
   authority expansion.

## Exact immutable qualification

Executed against implementation commit
`5831d1372b64c98ec9d7938efc7617e029a5a97b`:

- full unit suite: `137/137 files`, `2929/2929 tests` PASS;
- TypeScript typecheck: PASS;
- TypeScript build: PASS;
- `security:invariants`: `15/15` PASS;
- `git diff --check`: PASS;
- `/tmp/q`: absent after validation;
- cgroup `oom_kill`: `17 -> 17`;
- changed tests contain no `.skip`, `.todo` or `.only` weakening;
- registered MCP tool catalog remains exactly `45` tools;
- recursively audited strict object schemas: `107`, with zero non-strict object
  schemas found.

Exact fixed release fuzz execution:

- targets: `15`;
- total executions: `30067`;
- covered code ranges: `395`;
- iterations per target: `2000`;
- maximum input bytes: `1024`;
- maximum corpus: `256`;
- maximum runtime: `20000 ms`;
- fixed seed: `1374718481` (`0x51f08a11`);
- result: PASS.

The actual SH-05 release receipt machinery independently produced a clean
source-binding receipt for this exact commit/tree and a `security-fuzz` PASS
receipt carrying the same bounded artifact contract.

A full `release:assurance` run against this exact source returned
`BLOCKED_ENVIRONMENT`, not PASS, with intrinsic source gates PASS:

- typecheck: PASS;
- build: PASS;
- unit: PASS;
- authority-invariants: PASS;
- security-fuzz: PASS;
- SBOM: PASS.

The following remained explicitly unavailable in the governed worker:

- integration: Docker CLI unavailable and `KEYS_ENV` not configured;
- E2E: Playwright E2E dependencies unavailable;
- SAST: Semgrep absent;
- secrets: Gitleaks absent;
- SCA: OSV Scanner/offline database unavailable;
- config/image scan: Trivy/offline cache unavailable, plus image inputs for the
  image scan;
- provenance: release manifest, Sigstore bundle and public key unavailable.

These environment/tooling blockers are preserved as non-PASS release gates and
do not weaken SH-08 source acceptance.

## Security conclusion / non-claims

The exact-byte self-audit found no runtime-authority expansion beyond the
intentional fail-closed MCP schema tightening. Production MCP changes are
limited to replacing SDK raw object shapes/default objects with strict object
schemas; tool count, annotations and authorization calls remain preserved.

SH-08 does **not** claim:

- complete protocol fuzz coverage of SH-03 future MCP-v2 artifacts;
- crash/kill/restart chaos (SH-09);
- SSRF/egress qualification (SH-10);
- hostile Docker-world qualification (SH-11);
- prompt-injection campaign (SH-12);
- IDE/same-user adversarial campaign (SH-13);
- independent external penetration testing (SH-14);
- enterprise operational-security closure (SH-15);
- unavailable scanner/browser/integration/provenance release gates;
- P10/A9 or P11 completion.
