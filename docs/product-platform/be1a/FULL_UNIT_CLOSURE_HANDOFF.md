# BE1A Full-Unit Closure Handoff — SH05 / SH06 Executable Fixtures

## Governance

Implementation/orchestration lead only. This remediation is **not** self-accepted and requires independent review before BE1A full acceptance or convergence.

## Base

- BE1A R1 commit: `cfd92a9e5628bf862578d4449a189f547ea3dd2a`
- BE1A R1 tree: `bae79ba78b65f9db5483c1fb7b3e74a508bd45c2`
- Reviewed R1 result supplied by orchestration brief: `PASS_REVIEW_R1_REMEDIATION`

## Root cause

Both remaining full-suite failures were reproduced on the reviewed R1 candidate under the normal root wrapper and disappeared when only the executable fixture temp location moved to an executable filesystem.

Direct environment truth:

- `/tmp` is mounted `rw,nosuid,nodev,noexec`;
- `scripts/run-vitest-clean.mjs` intentionally owns the serialized test root `/tmp/q` and redirects `TMPDIR/TMP/TEMP` there;
- SH05 creates a fake executable `cosign` under `tmpdir()`;
- SH06 creates fake executable `docker`, `git`, and `curl` shims under `tmpdir()`.

Classification:

- primary: `ENVIRONMENT_DEFECT`;
- manifestation: `TEST_FIXTURE_DEFECT`;
- not classified as a product-source defect.

Controlled proof on unchanged R1 source with only `TMPDIR/TMP/TEMP` moved to an executable workspace root:

- SH05: 10/10 PASS;
- SH06: 59/59 PASS.

## Narrow remediation

Added `tests/helpers/executableFixture.ts` and changed only the two failing test files.

General fixture state remains under the existing serialized `/tmp/q` contract. Only executable fake tools are placed in a unique ignored `node_modules/.cache/quarangate-executable-fixtures` root. The helper:

- creates an owned unique directory;
- validates containment under its cache base;
- uses bounded accepted prefixes only;
- sets restrictive permissions;
- performs an actual executable probe before returning on Unix;
- cleans the per-test root after use.

No production release provenance code, Cosign version policy, signature verification, SH06 recovery source, Docker authority, runtime configuration, or deployment logic was weakened or changed.

## Validation

- typecheck: PASS
- build: PASS
- focused SH05 + SH06 under root wrapper: 2 files / 69 tests PASS
- complete serialized root unit suite: 175 files / 3400 tests PASS
- security invariants: PASS (16 rules, 12 compose files, 7 Dockerfiles)
- SCA: PASS (0 vulnerabilities at high threshold, omit dev)
- bounded secret scan: PASS
- diff check: PASS

See `evidence/FULL_UNIT_CLOSURE_VALIDATION.txt` and `evidence/FULL_UNIT_CLOSURE_VITEST.txt`.

## Acceptance boundary

This candidate only closes the required full-suite blocker. It does not itself accept BE1A, integrate a convergence branch, start BE8, push, deploy, or mutate live runtime.

Independent review is required before convergence.
