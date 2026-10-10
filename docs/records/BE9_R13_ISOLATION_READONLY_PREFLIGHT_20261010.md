# QuaranGate BE9.2 R13 — Isolated Docker Read-Only Preflight, 2026-10-10

**Document status:** Author-produced evidence index, not independent acceptance.
**Scope:** Dedicated P10 WSL2 daemon only. No live Docker assessment broker was created.

## Frozen source and offline image

| Item | Exact identifier |
|---|---|
| R13 commit | `3ec721f8ea9a6dc6f28cfa9831dc34c7d6fbbe79` |
| R13 tree | `6c8cfd5928e173859c6cef4a8cdc8cc1e2e35a04` |
| Isolated Docker Engine ID | `c6bbb811-9555-4736-b0bf-2b6c8314ddb1` |
| Dedicated Docker Unix socket | `/run/docker-quarangate-p10.sock` |
| Separate Docker data root | `/var/lib/quarangate-p10/docker` |
| R13 offline image tag | `quarangate:p10-r13-3ec721f-qualified` |
| R13 offline image ID | `sha256:04352b4831bef48fe00130c59f10841f8f702b683e46964480a84179d71423a3` |

## Read-only qualification — observed PASS

Author-created preflight under `/opt/quarangate-p10/evidence/r13-isolated-readonly-preflight.mjs` ran against the dedicated isolated engine without changing any Docker resources.

**Final baseline result:** `READONLY_PREFLIGHT=PASS`; `CHECKS=25`; `FAILURES=0`.

The checks include:

- exact Docker Engine ID, root directory and dedicated Unix socket;
- absence of default `/var/run/docker.sock`;
- absence of mounted Windows drive filesystems; WSL automount and interop disabled by configuration;
- expected immutable Git HEAD and tree and clean isolated checkout;
- zero containers, zero volumes, and no non-default Docker networks;
- exact R13 image ID and OCI revision label;
- verified SHA-256 of the original author build log, build result and offline npm bundle evidence;
- rejection of inherited `DOCKER_HOST`, `DOCKER_CONTEXT`, or Docker TLS variables that redirect selection.

**Adversarial non-mutating checks:**

- Injected `DOCKER_CONTEXT=desktop-linux` → `READONLY_PREFLIGHT=FAIL`, one expected failed check, non-zero exit.
- Injected `DOCKER_HOST=unix:///var/run/docker.sock` → `READONLY_PREFLIGHT=FAIL`, one expected failed check, non-zero exit.
- Clean environment rerun → `READONLY_PREFLIGHT=PASS`, 25/25 checks.

**Final local integrity anchors:**

- `r13-isolated-readonly-preflight.mjs` SHA-256: `90641af619eadec2be3ed615ea389c0bbfc45ad316591a547d2f89953988a133`.
- `r13-isolated-readonly-preflight.json` SHA-256: `9edca2e71155a02a5d30b4c3b91ca724292f2a57b30780afc5ac35d5d680ac78`.
- Original offline-build log SHA-256: `1798217320b350a02c5508ef7abe8bd2076c89f83ae76d3abeaed8a1a4f10504`.
- Original build result JSON SHA-256: `5f49c07141959a802e868ee27488fcfee34fd66440eab9b9dc28499062146ca2`.

## Important assurance boundaries

This is **a preflight detector**, not an independently verified, mechanically enforced launcher or a daemon-global ownership authority.

The 25 checks are successful author-run checks. The test does **not** prove broker singleton, process ownership, restart fencing, Docker-daemon concurrency safety, orphan cleanup or production rollout eligibility.

An earlier connected-execution safety restriction blocked the disposable Docker Authority broker setup. That restriction was not rerouted or bypassed. Therefore:

`LIVE_ASSESSMENT_CONCURRENCY=NOT_RUN`
`R13_SOURCE_SECURITY=INDEPENDENT_PASS_REVIEW_SCOPED`
`DEPLOYMENT_OWNERSHIP_REVIEW=PENDING`
`BE9_2_ACCEPTANCE=NOT_AUTHORIZED`
`CANONICAL_CONVERGENCE=BLOCKED`
`BE10=NOT_AUTHORIZED`

At the read-only host check preceding this note, the original four Docker Desktop-backed Docker Authority containers still reported `unhealthy`. Their recovery is a separate live-runtime incident and is not resolved by the isolated preflight.

## Independent continuation

A separate reviewer must verify the exact Git/OCI/evidence identities and source, review the preflight for bypasses, qualify the Docker authority-domain ownership contract, and review an appropriately authorized disposable live concurrency campaign before recommending deployment acceptance. Keep the source branch frozen and do not merge to `main` based on this record.

This document intentionally omits secrets, private `.env` material, VM contents, raw Docker logs, source tar archives and other host-private evidence. The raw author evidence remains in the dedicated isolated distro.
