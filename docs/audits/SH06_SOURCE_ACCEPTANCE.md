# SH-06 Source Acceptance

## Verdict

`OWNER_AUTHORIZED_STRICT_SELF_AUDIT_PASS / SH06_SOURCE_ACCEPTED`

This is a source-only acceptance receipt. It is **not** independent review,
owner-host live deployment proof, provider certification, rollback execution,
P10/A9 qualification, P11 release approval, or production promotion.

## Accepted implementation candidate

- branch: `security/sh06-immutable-image-base-gpt`
- implementation commit: `27f72ee2e7b782ff6838b710a48f26d72667b071`
- implementation parent: `51c94b25ce69de7eb2dbd48802444645cf8fe888`
- subject: `security(sh06): bind immutable image identities`
- implementation paths: `27`
- implementation patch SHA-256: `bc84b2e5215ab0199f0be8ea784e378a6cfe3a826314bec36d0d0b4d2e623134`
- implementation tree-archive SHA-256: `3acd2aed06cac6b3bac17428f4297abe2a668cc0d082c229211d74157e3f7bbe`
- implementation content-manifest SHA-256: `4b3d79bd0024365dc744a9154a1cca61e8b46992068a79ab9503c88ca87dc7b1`

## Accepted source properties

SH-06 source acceptance covers the following exact properties:

1. all seven tracked external Dockerfile `FROM` inputs are SHA-256 digest-pinned;
2. primary gateway, Docker-authority and executor image selections are mandatory,
   have no `quarangate:latest` fallback, and use `pull_policy: never`;
3. candidate deployment captures, persists and verifies service-specific image
   tags together with exact Docker `sha256:` image IDs;
4. unattended recovery fails closed when persisted tag-to-image-ID bindings do
   not match, and verifies live containers by both reference and image ID;
5. optional Ollama service selection is digest-only for production recovery;
6. Kiro and Ollama trusted helper/runner/stager references are resolved through
   the already-governed `image.inspect` operation to immutable Docker image IDs
   at executor startup before provider availability;
7. Copilot/GitHub immutable image-ID behavior remains preserved;
8. the raw Docker socket remains confined to the dedicated Docker-authority
   broker; executor/gateway authority is not broadened;
9. no package/dependency manifest changed;
10. the security invariant gate is 15 rules over 10 Compose files and 7
    Dockerfiles and includes a negative tag-only-base regression.

## Immutable-candidate qualification

Executed against exact implementation commit
`27f72ee2e7b782ff6838b710a48f26d72667b071` after the final wording amendment:

- full unit suite: `131/131 files`, `2902/2902 tests` PASS;
- TypeScript typecheck: PASS;
- TypeScript build: PASS;
- `security:invariants`: PASS, `15/15` rules, `10` Compose files, `7` Dockerfiles;
- modified shell syntax: PASS;
- `git diff HEAD^ HEAD --check`: PASS;
- `/tmp/q`: absent after the full run;
- cgroup `oom_kill`: `17 -> 17`;
- worktree status: clean;
- staging: empty.

The final exact-byte strict self-audit also returned PASS with:

- source delta limited to `src/executor/index.ts` plus governed config/scripts/docs/tests;
- Docker-authority source/API delta: none;
- executor Docker client authority delta: none;
- dependency-manifest delta: none;
- raw Docker socket scope: dedicated broker only;
- changed-test `.skip` / `.todo` / `.only`: none;
- primary immutable-image policy: PASS;
- Kiro/Ollama startup immutable binding: PASS.

## Live truth / non-claims

The following remain **NOT_YET_QUALIFIED** by this receipt and must not be
silently promoted to PASS:

- presence of every pinned base image on the owner host;
- owner-host build of this candidate;
- migration of the owner runtime `.env` to all six service ref/image-ID keys;
- migration of any existing Ollama service selection to an exact digest;
- candidate live deployment, restart and rollback;
- provider inference/cancellation/egress requalification;
- P10/A9 exact-final-candidate qualification;
- P11 release, production deployment or post-deploy acceptance.

These later gates may be blocked by owner-host/runtime/provider environment, but
they do not weaken this accepted source policy.
