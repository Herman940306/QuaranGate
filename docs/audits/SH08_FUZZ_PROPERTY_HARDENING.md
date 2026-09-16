# SH-08 Fuzz / Property-Based Security Hardening

Status: IMPLEMENTED_CANDIDATE / PRE_ACCEPTANCE

SH-08 adds deterministic property testing and bounded coverage-guided fuzzing to the existing security corpus. It is intentionally separate from SH-07 cross-plane adversarial composition and SH-09 crash/kill/restart chaos.

## Boundaries

The fuzz runner is local-only and no-download. It exercises pure parsers, canonicalizers, validators and redaction logic only. It does not open network sockets, invoke providers, mutate Docker state, access the Docker socket, mutate project files, or widen any caller authority.

Fixed release-run bounds are:

- seed: `0x51f08a11` (`1374718481`)
- targets: `15`
- iterations per target: `2000`
- maximum fuzz input: `1024` UTF-8 bytes
- maximum retained corpus entries per target: `256`
- precise-coverage sample interval: `16`
- global fuzz runtime ceiling: `20000 ms`

Coverage guidance uses Node's built-in `node:inspector` precise-coverage API. Candidate mutations are retained only when a sampled batch opens previously unseen executed ranges for that target. No third-party fuzzing dependency or network acquisition is introduced.

## Security property coverage

Deterministic seeded properties cover:

- workspace-relative path normalization/confinement;
- apply-path to exact-guard representability without wildcard widening;
- Docker archive entry confinement and evidence-path allowlisting;
- bounded evidence reads;
- Docker image reference parsing/validation;
- GitHub repository/ref/commit identity grammars;
- generated agent/IDE identifiers;
- OAuth resource canonicalization;
- secret redaction idempotence and removal;
- IDE auth, handshake and remote-frame canonical round-trip or typed fail-closed rejection;
- canonical JSON insertion-order invariance;
- strict snapshot and installation manifest validation;
- MCP tool input/output schema strictness across the complete registered catalog.

Every deterministic property failure reports its fixed seed and iteration. Coverage-guided fuzz failures report target, seed, iteration and exact bounded input.

## Product defect discovered by SH-08

SH-08 inspection of pinned `@modelcontextprotocol/sdk@1.30.0` proved that raw Zod shapes passed to `McpServer.registerTool()` are converted by the SDK to ordinary `z.object(shape)` schemas. Zod's default object behavior strips unknown fields rather than rejecting them.

Before remediation, this meant non-Agent-Control-Plane MCP tool inputs could silently accept extra caller fields and, more importantly, output validation could silently strip unexpected fields instead of failing closed. The latter weakens the output schema as a data-leak/integrity guard.

The remediation converts core, GitHub and Control Center tool contracts to explicit recursively strict Zod object schemas. Agent Control Plane schemas were already strict and were not redesigned. The exact tool catalog remains `45` tools and no tool authority, scope, annotation or handler capability is added.

The regression harness instantiates the real pinned MCP server and verifies:

- exactly `45` registered tools;
- at least `100` recursively inspected object schemas (currently `107`);
- every inspected object schema rejects unknown keys;
- the real pinned SDK rejects generated unknown input fields;
- unexpected top-level and nested output fields fail validation.

## Release-assurance integration

`security-fuzz` is a mandatory intrinsic gate in `security/release-policy.json` and the existing release receipt/policy/evidence-bundle machinery. The fixed release gate invokes only:

`node scripts/security-fuzz.mjs --build --iterations 2000 --max-input-bytes 1024 --max-corpus 256 --max-runtime-ms 20000`

The receipt validates exact bounded fuzz metadata before a PASS can be recorded. P10/P11 release assurance therefore cannot omit SH-08 without causing missing/invalid required-gate evidence.

## Candidate qualification before freeze

At the pre-freeze checkpoint:

- SH-08 focused/adjacent: `19/19 files`, `564/564 tests` PASS;
- full unit: `137/137 files`, `2929/2929 tests` PASS;
- typecheck: PASS;
- build: PASS;
- authority invariants: `15/15` PASS over `10` Compose files and `7` Dockerfiles;
- exact release-sized fuzz: `15` targets, `30067` total executions, `395` covered ranges, PASS;
- diff-check: PASS;
- `/tmp/q`: absent;
- cgroup `oom_kill`: unchanged at `17` across widened validation.

These are candidate results only. Source acceptance requires immutable-commit requalification and strict exact-byte audit. This document does not claim independent review, live-provider qualification, owner-host deployment qualification, penetration-test certification, production release approval or SH-09 chaos coverage.
