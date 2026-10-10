# QuaranGate BE9.2 R13 — Source Backup and Isolated Qualification Record

**Recorded:** 2026-10-10
**Record type:** preservation / provenance / continuation; **not** a production or acceptance declaration
**Canonical main:** unchanged by this record and by the R13 source backup.

## GitHub source preservation

- Repository: `Herman940306/QuaranGate` (public).
- Frozen source backup branch: `fix/qg-be9-r13-volume-attachment-gpt`.
- Exact source commit: `3ec721f8ea9a6dc6f28cfa9831dc34c7d6fbbe79`.
- Exact Git tree: `6c8cfd5928e173859c6cef4a8cdc8cc1e2e35a04`.
- Direct rejected R12 parent: `e013414fd4c4b9248563cdde8006ad302e14b634`.
- R13 change: serialized assessment volume-attachment ownership in Docker Authority, plus adversarial test coverage and SH-11 assertion update. Three R13 paths changed relative to R12.
- The source branch is a preserved *unmerged* development and remediation line, with earlier ancestry, not a release tag.
- GitHub `main` head at record creation: `89b588681028742e6edbd091b9ce3a32ac0fcb30`; no push to main.
- Publication safety review: a heuristic scan of 1,937 new Git blobs over 253 commits found 31 candidate pattern matches; triage identified placeholders, security-test fixtures, and validation-status markers, with no confirmed active credential. This does **not** certify absence of all sensitive information.

## Source and author qualification

- An independent reviewer previously reported `R13_SOURCE_SECURITY=PASS_REVIEW_SCOPED` for the within-broker R12-F04 fix. This is not a daemon-wide deployment approval.
- Author-run commit-bound unit qualification: 189 files, 3,551 tests PASS.
- Author-run focused suite: 16/16 PASS.
- TypeScript typecheck/build/security invariants: PASS.
- Author qualification evidence is preserved locally in the R13 safety-evidence area, with SHA-256 manifests.
- R13 source branch and isolated source checkout were verified clean at the stated Git commit/tree.

## Dedicated P10 daemon qualification (author only)

- Separate WSL2 distro: `QuaranGate-P10-Isolated`.
- Native Docker Engine version 29.1.3; engine ID `c6bbb811-9555-4736-b0bf-2b6c8314ddb1`.
- Engine data root: `/var/lib/quarangate-p10/docker`.
- Dedicated engine endpoint: `unix:///run/docker-quarangate-p10.sock`.
- The distro has Windows automount and interop disabled; default Docker socket absent on qualification checks. This is an engine/socket boundary, not a claim of isolation from privileged host administrators.
- Frozen R13 source bundle and two base-image exports transferred with six verified SHA-256 checks.
- Offline npm lockfile SHA-256: `15bdce912856da9b8eddddb49aa1e382e3515a00945fdd8c46d1fb8beb29f46b`; offline manifest SHA-256: `5ed9cec31932e4ccf6d1b16f58b1485efd9774f6a39f9b1eeb3c709dfe2d4c7e`.
- Verified npm bundle: 218 artifacts, 219 package entries.
- Offline Buildx image tag: `quarangate:p10-r13-3ec721f-qualified`.
- Immutable output image ID: `sha256:04352b4831bef48fe00130c59f10841f8f702b683e46964480a84179d71423a3`.
- Build used `--network=none`, `--pull=false`, `--no-cache`, with no registry activity detected by the build checker.
- The imported base retained the expected image ID, but not its repository-digest alias. The qualification-only wrapper used the source helper to supply the exact immutable base as an OCI context. This deviation **must** be reviewed; it was not a change to committed source.
- Build log SHA-256: `1798217320b350a02c5508ef7abe8bd2076c89f83ae76d3abeaed8a1a4f10504`.
- Build result JSON SHA-256: `5f49c07141959a802e868ee27488fcfee34fd66440eab9b9dc28499062146ca2`.
- Bundle verification JSON SHA-256: `6dca06f2f7acec1ab948be1f658270fb2fb200e7ce1961253c9612e5d886679d`.
- Author build status: `OFFLINE_BUILD_PASS_AUTHOR_ONLY`. No acceptance of image for production use.

## Open security and runtime gates

1. **Live Docker assessment concurrency qualification NOT RUN.** A connected execution security control refused a disposable broker setup; the denied action was not rerouted. Read-only inspection afterward found zero qualification containers and no custom network.
2. **Daemon ownership/fencing review PENDING.** A dedicated engine exists, but fail-closed launcher bindings, broker singleton, restart/overlap behavior, and adversarial races remain unqualified.
3. **Legacy Docker Desktop integration incident OPEN.** At the last read-only inspection, four pre-existing legacy Docker Authority containers reported `unhealthy`. They were not repaired as part of this source backup or isolated image build.
4. **BE9.2 project-control acceptance NOT AUTHORIZED; backend convergence and BE10 remain BLOCKED.** No source merge or deployment authorization is implied by publishing this record.

## Preservation limitations and continuation

This GitHub record intentionally contains **no** raw Docker logs, private `.env` files, authentication material, host secrets, local image archives, VM disk images, or raw machine-level evidence. Those artifacts must be preserved under their existing restricted local evidence/transfer stores and backed up separately to an appropriately private destination.

The next independent reviewer should verify the published source SHA, the local evidence hashes, the isolated daemon identity, and any authorized disposable live qualification before recommending deployment-ownership acceptance. **Do not mark this record as `PASS_REVIEW` or merge the R13 branch based solely on author-side tests.**

## Recovery references

- Source: `https://github.com/Herman940306/QuaranGate/tree/fix/qg-be9-r13-volume-attachment-gpt`
- Exact commit: `https://github.com/Herman940306/QuaranGate/commit/3ec721f8ea9a6dc6f28cfa9831dc34c7d6fbbe79`
- Local qualification log group: `/opt/quarangate-p10/evidence/` inside the isolated distro.
- Local source qualification log group: QuaranGate R13 safety evidence `be9-r13-attachment-3ec721f-20261010`.

**Record governance:** authored on separate documentation-only safety branch. R13 frozen source, GitHub default branch, and running Docker containers were not modified by this record.
