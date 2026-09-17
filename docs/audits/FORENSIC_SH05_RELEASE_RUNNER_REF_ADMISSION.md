# Forensic convergence — SH-05 release-runner ref admission

**Status:** REMEDIATED SOURCE CANDIDATE / NOT A LIVE GITHUB-RUNNER CLAIM

## Discovery

Preserve-first convergence compared divergent SH-05 history with current canonical instead of assuming old CI branches were merge debt. Historical commit `af0d7fa1a03c960e9ba7bc7bae7ae364252cf6a2` contained a post-SH-05 ref restriction that was not present on canonical `f9b60aeef1c6af7da3434f792baa866a29d0356f`. The historical branch itself is not merged or reused as the writer lane.

Current canonical retained both `workflow_dispatch` and the dedicated `[self-hosted, linux, x64, quarangate-release]` runner, but had no job-level `github.ref` admission condition. Its source-binding step proved only `HEAD == GITHUB_SHA` and a clean worktree.

## Finding

GitHub documents `workflow_dispatch` as targetable at a selected branch or tag: `GITHUB_REF` is the branch/tag receiving the dispatch and `GITHUB_SHA` is the last commit on that ref. GitHub also evaluates a job-level `if` before routing the job to a runner.

Therefore the existing `HEAD == GITHUB_SHA` check answers **which selected ref is executing**, but does not by itself answer **whether that ref is authorized to consume the privileged release-runner surface**. A manual dispatch of a feature ref could otherwise reach the dedicated self-hosted release job, subject only to external repository permissions.

## Red-before-fix evidence

A focused regression was added first to require the release job to admit only:

- canonical forward `refs/heads/integrate/quarangate-forward`; or
- a `refs/tags/v*` ref when the event is the already-declared `push` trigger.

Before source repair, `tests/unit/sh05-release-assurance.test.ts` failed exactly that assertion (`1 failed / 3 passed`).

## Remediation

The release job now uses this scheduling-layer admission condition:

`github.ref == 'refs/heads/integrate/quarangate-forward' || (github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v'))`

Consequences:

- push on canonical forward remains eligible;
- push of the existing `v*` release-tag trigger remains eligible;
- manual dispatch on canonical forward remains eligible;
- manual dispatch on a feature branch is skipped before runner assignment;
- manual dispatch on a tag is also skipped rather than treating tag shape alone as manual-run authority.

The existing exact-SHA/clean-worktree check remains required after admission. No trigger, runner label, scanner, evidence path, credential, Docker authority, network authority, or release-policy contract is broadened.

## Governance boundary

This source gate is defense in depth. Repository write access, branch/tag creation/protection, Actions permissions, runner-group/repository access, and any environment protection are GitHub/owner governance controls and must be independently configured and verified. This source change does not claim those external controls exist, does not claim a live GitHub Actions run occurred, and does not convert repository source policy into external platform proof.

## Qualification

Working-byte qualification after the minimal remediation:

- red-before-fix: focused SH-05 orchestration `1 failed / 3 passed`, failing exactly because the job-level ref admission expression was absent;
- focused SH-05 orchestration after repair: `4/4 PASS`;
- complete current SH-05 unit matrix: `98/98 PASS across 14/14 files`;
- full repository unit corpus: `3077/3077 PASS across 148/148 files`;
- root typecheck: PASS;
- root build: PASS;
- workflow YAML parse: PASS, with exact job `if` expression and unchanged `[self-hosted, linux, x64, quarangate-release]` runner labels;
- security invariants: `16/16 PASS` over `10` Compose surfaces and `7` Dockerfiles;
- `git diff --check`: PASS;
- deterministic security fuzz: PASS, seed `1374718481`, `15` targets, `30067` executions, `395` coverage ranges.

The fresh worktree intentionally had no local dependency installation. For the fuzz replay only, candidate `package.json` and `package-lock.json` were first proven byte-identical to canonical (`package.json` SHA-256 `7d4ab30329f26c13bed497920d104214a101143b87877d4c59e1569220d253e1`; lockfile SHA-256 `31688b0a46cb5051e069ff049bbafd34752ace10dfb9dac3a60c9a3fef5258e5`), then canonical's already-qualified dependency tree was exposed through a temporary ignored `node_modules` symlink. No dependency was installed or downloaded, and the temporary symlink was removed immediately after fuzz execution.

No live GitHub Actions/self-hosted-runner execution is claimed by this source qualification. Immutable commit identity and SHA-256 receipts are recorded after freeze.
