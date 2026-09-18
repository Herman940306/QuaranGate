# QuaranGate Installer & Lifecycle Productization — D1/D2

**Status:** Historical D1/D2 lifecycle source is integrated. A current-line production-install bridge remediation is source-qualified pre-freeze on canonical base `2a576f2d8ce47f680ca3f102aa39dc13b0dc1315`; immutable freeze/review/promotion remain pending. The real signed Windows release package and live production qualification remain pending.

**Roadmap role:** D1 and D2 must close before A9 production hardening begins.

## Product goal

The intended release experience is **click install + guided owner setup**, not a terminal-first Docker/WSL/Compose runbook.

Normal users should not need to clone a repository, hand-edit YAML, construct Docker Compose commands, manage WSL paths or manually wire autostart for supported workflows. Setup convenience must never silently choose security-sensitive permissions for the owner.

## D1 — Guided installer and first run

1. **System readiness:** detect supported OS/runtime, Docker, CPU/RAM/storage, GPU, Git and optional remote prerequisites; guide remediation with consent and no silent privilege escalation.
2. **Usage/profile selection:** Recommended, Developer, QA/Testing and Advanced/Custom starting profiles while preserving explicit owner authority.
3. **Project enrollment:** choose folders and read-only/read-write access with safe protection defaults for Git metadata, secrets/environment files and guarded paths.
4. **AI provider setup:** detect/configure Kiro, Copilot and local AI; keep credentials outside committed config, logs and ordinary evidence.
5. **Local AI profile:** recommend efficient/balanced/custom resource choices from actual hardware, with exact model/runtime details available in advanced mode.
6. **IDE integration:** detect supported IDEs after I1-I6 and offer deliberate enrollment without requiring hand-edited client JSON for normal setup.
7. **GitHub integration:** provide governed App/OAuth setup and clearly explain repository/account access; never broaden App permissions merely for convenience.
8. **Remote access:** ask explicitly whether remote access is desired; preserve loopback-bound QuaranGate and never silently open router ports, firewall rules or public Docker/executor listeners.
9. **Client permissions:** human-readable per-client/project choices such as read files, run tests, dispatch agents, review changes, apply approved changes or administer infrastructure.
10. **Startup/recovery:** productize the proven Windows Task Scheduler -> PowerShell -> WSL -> Docker/QuaranGate recovery path where applicable.
11. **Recovery/backup policy:** Recommended/Minimal/Custom retention and backup choices with clear storage location.
12. **Final review and consent:** summarize projects, agents, GitHub, remote access, startup, local AI and important permissions before any machine mutation.
13. **Completion:** finish in the QuaranGate Control Center with health/setup validation, not an undocumented terminal handoff.

## D2 — Upgrade, repair, rollback and uninstall

D2 must prove:

- supported-version upgrades and configuration/schema migration;
- credential preservation or explicit reauthorization;
- model/artifact preservation according to owner choice;
- pre-upgrade backup/recovery anchors;
- failed-upgrade rollback;
- repair/reconcile installation;
- safe supported rollback where feasible;
- uninstall of application components;
- explicit preserve/remove choices for projects, evidence, models, credentials, backups and local state;
- reinstall without duplicate authority or stale registrations.

Selecting “Uninstall” must never imply destructive removal of user data.

## Packaging direction

The desired Windows experience is a signed, user-friendly installer executable such as `QuaranGate-Setup.exe`, or equivalent trusted packaging appropriate to the final architecture. Exact installer technology, signing pipeline and distribution channel remain D1 implementation decisions based on the then-current product.

## D1/D2 acceptance direction

Before A9, qualification must cover a fresh/clean install, first run, restart/recovery, upgrade, failed-upgrade rollback, repair, uninstall/data-preservation choices and reinstall, proving both usability and unchanged security boundaries.

## Isolated P9 implementation architecture

The current P9 remediation candidate implements the source-level lifecycle boundary as:

- a native Windows Forms production wizard (`scripts/windows/QuaranGate-Setup.ps1`) with a RemoteSigned click launcher that forwards the signed-release arguments and never uses hidden elevation;
- a fixed-argument WSL/Node installer controller (`src/installer/cli.ts`) with source-only `plan` plus production `plan-production` / `apply-production` commands; production planning cryptographically verifies the exact release manifest, detached Ed25519 proof, installer-owned trust policy and every manifested payload byte **before** owner review;
- a deterministic D1 policy layer (src/installer/productInstaller.ts) that maps human choices to the existing QuaranGate scopes rather than creating a second authority system;
- a strict release-package manifest (`src/installer/releasePackage.ts`) plus production profile (`src/installer/productionRelease.ts`) binding every payload file and the exact `docker-authority`, `executor`, `gateway`, and `projects-work` OCI images to immutable identity; installer trust is supplied separately from release material;
- deterministic fresh-install runtime configuration (`src/installer/runtimeConfig.ts`) that writes private atomic config, keeps providers/GitHub/IDE/remote activation deferred to their later qualification steps, stores only the owner key hash, and returns the plaintext owner credential once after successful install;
- a concrete WSL production platform (`src/installer/wslProductionPlatform.ts`) and bounded production start/stop + Windows Task Scheduler control scripts that use fixed argv, inspect exact managed authority/image identities, refuse pre-existing same-name authority on fresh install, start with `--no-build --pull never`, and clean partial newly-managed runtime state on failed startup validation;
- a versioned installation manifest plus D2 planner/coordinator (`src/lifecycle/**`) with plan-before-mutation, exact path+mode-bound recovery anchors, runtime quiescing before upgrade/repair mutation, recoverable repair, credential preservation or reauthorization, supported rollback, preserve-by-default uninstall, reinstall attestation and interruption classification;
- private atomic lifecycle persistence with traversal, symlink, junction-equivalent path alias, hard-link, permission and bounded-read defenses;
- bounded/redacted lifecycle evidence.

The production wizard no longer treats an unsigned source-tree review as install authority. Its production path requires explicit release-manifest, detached-signature and independently supplied trust-policy inputs; `plan-production` verifies them and the complete payload before displaying the digest-bound review. After explicit owner consent, `apply-production` re-verifies the same release, re-probes the current host, rebuilds the plan and refuses any release/host/answer/digest/consent drift before lifecycle mutation. The legacy source-only `plan` command remains non-mutating and cannot satisfy the production release gate.

## Current qualification boundary

The deterministic unit/integration harness uses disposable roots and typed fake lifecycle drivers. It proves non-host-specific D1/D2 policy, persistence and recovery behavior without touching live QuaranGate, real credentials, Task Scheduler, Docker state, provider entitlements, models or project data.

The following remain outside this source qualification and must not be inferred as PASS:

- immutable current-line remediation freeze, independent/read-only review (or explicitly classified owner-authorized self-audit if no independent reviewer is available), and guarded canonical promotion: PENDING;
- final signed `QuaranGate-Setup.exe` build: `DEFERRED_EXTERNAL_OWNER_CREDENTIAL` plus a trusted Windows packaging/AuthentiCode toolchain;
- exact release-manifest/signature/trust/package regeneration against the eventual frozen release candidate: PENDING;
- live Windows 11/WSL2 fresh-install, restart/recovery, upgrade, failed-upgrade rollback, repair, uninstall/data-preservation and reinstall rehearsal: NOT_RUN;
- provider, GitHub, IDE and remote activation remain post-install qualification work and are not silently enabled by fresh install;
- P10/A9 15-step system-E2E, P10-V rendered/visual evidence, and P11 release/promotion: NOT RUN / NOT ACCEPTED;
- production deployment: NOT_RUN.
