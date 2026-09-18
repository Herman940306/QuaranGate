# P9 D1 + D2 Product Lifecycle — Isolated Source Candidate

> **Current-line reconciliation — 2026-09-18:** The historical lane, hashes and acceptance record below are intentionally preserved. Canonical later advanced to `2a576f2d8ce47f680ca3f102aa39dc13b0dc1315`. A new isolated current-line remediation, `fix/p9-production-install-gpt`, closes the production signed-release/apply bridge that the historical source deliberately deferred. See **Current-line production-install bridge remediation** at the end of this record. Nothing in the historical chronology is retroactively rewritten.


## Scope and governance

- Owner: Herman
- Writer: Codex, isolated lane only
- Branch: lane/p9-d1-d2-product-lifecycle
- Worktree: /workspace/QuaranGate-p9-product-lifecycle
- Accepted base: d720f0f912ed24f876c9e24fa47b281a58dd87b2
- Canonical integration: not authorized
- Production deployment: not run
- Project-control mutation: none
- Agent A P7/I2 lane mutation: none

This record covers the parallel P9 source implementation only. Final P9 acceptance remains downstream of independent review, P7 completion and forensic convergence.

## Pre-mutation evidence

The exact gate was verified before creating the isolated lane:

- forward branch integrate/quarangate-forward at d720f0f912ed24f876c9e24fa47b281a58dd87b2;
- forward parent dcb3517bd53d425f7e796261d12bb4abde27f0ec;
- forward staging empty;
- only known forward untracked path: node_modules;
- project-control HEAD 1cfb58018d9b441bb6f15e853c6a23c35949f9fc;
- project-control staging empty;
- reserved control handoff SHA-256 792ca0a1923837f6d0d033238610edc87c6839ab633f16490dac1ef7e354616f;
- P9 worktree absent;
- P9 branch absent.

The lane was then created at the exact authorized base. No existing work was adopted, reset, cleaned, stashed, rebased or overwritten.

## Architecture decision

Selected architecture:

WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE

The source candidate consists of:

1. Native Windows Forms review wizard source with a RemoteSigned click launcher.
2. Fixed-argument WSL/Node host-readiness and installer-plan controller.
3. Digest-bound owner review/consent contracts.
4. Strict, immutable release-package file and OCI-image identities.
5. Versioned installation manifest and schema migration history.
6. Plan-before-mutation D2 lifecycle coordinator using typed operations rather than caller-selected commands.
7. Private atomic lifecycle storage and recovery journals.
8. Exact pre-upgrade recovery anchors with SHA-256 metadata.
9. Fail-closed rollback and interruption classification.
10. Bounded, redacted lifecycle evidence.

Why this architecture was selected:

- it matches the accepted Windows 11 -> WSL2 -> Linux containers product topology;
- it reuses existing QuaranGate authority rather than adding Docker, host-command, IDE or permission planes;
- it can be wrapped by a signed Windows installer later without changing the lifecycle contract;
- the policy, migration and recovery core is deterministic and testable without live production mutation;
- it uses only Node built-ins plus dependencies already present in the accepted repository;
- it keeps release signing and package construction explicit rather than faking either.

## Packaging/toolchain evidence

The isolated projects-work environment was checked without acquisition:

- powershell.exe: not found;
- pwsh: not found;
- WiX tools: not found;
- NSIS makensis: not found;
- Inno Setup iscc: not found;
- 7z: not found;
- zip: not found.

No package or installer framework was downloaded. No network dependency acquisition occurred.

The Windows wizard source deliberately refuses unsigned source-tree installation after review and reports PACKAGE_APPLY_DEFERRED_RELEASE_GATE. A real QuaranGate-Setup.exe build and cryptographic signing remain a release-gate action requiring a trusted Windows packaging toolchain and owner signing identity.

## D1 implementation

### System readiness

src/installer/hostProbe.ts uses fixed executable/argument arrays (never a shell) for Docker, Compose, Git, Node and optional NVIDIA detection. It records only bounded facts. The filesystem probe checks same-filesystem atomic rename, case behavior, free space and symlinked install roots using a cleaned temporary probe directory.

Readiness statuses are exact:

- READY;
- REMEDIATION_REQUIRED;
- UNSUPPORTED;
- BLOCKED.

The current source policy supports Linux and Windows/WSL2, refuses native Windows-without-WSL2, and leaves macOS release qualification explicit.

### Guided choices and authority

src/installer/productInstaller.ts implements:

- Recommended, Developer, QA/Testing and Advanced/Custom profiles;
- safe read-only project enrollment defaults;
- explicit read/write enrollment with protected .git, environment, secret and credential paths;
- Kiro/Copilot entitlement deferral and credential references only;
- hardware-bounded efficient/balanced/custom local AI selection;
- UPSTREAM_P7_PENDING IDE state or exact accepted contract digest binding;
- selected-repository GitHub authority with no wildcard convenience grant;
- local-only remote default and explicit private/reversible Tailscale opt-in;
- human permission labels mapped to existing QuaranGate scopes;
- limited-user startup planning;
- Recommended/Minimal/Custom backup policies;
- a deterministic final review and consent digest;
- health validation before the loopback Control Center is opened.

No client permission is inferred from profile text after the review plan. Sensitive project, provider, GitHub, remote, startup and powerful scope choices are individually named in requiredConsents.

### Wizard boundary

scripts/windows/QuaranGate-Setup.ps1 provides the owner-facing source wizard and invokes the WSL planner through one argument array. It does not store provider secrets, use hidden elevation, alter firewall/router policy, expose Docker, or claim success from an unsigned source tree.

scripts/windows/QuaranGate-Setup.cmd uses RemoteSigned, not ExecutionPolicy Bypass.

## D2 implementation

### Installation identity

src/lifecycle/manifest.ts validates a strict manifest containing:

- product/source/release identity;
- config and state schema versions;
- exact installed components;
- provider/IDE/GitHub integration state;
- explicit state/evidence/model/backup/cache roots;
- immutable runtime/image identities;
- migration records;
- startup and client registration identities;
- lifecycle state and verified health;
- ODR-2 hybrid session-resume policy as context policy, never authority.

Unknown fields, mutable latest image references, unsorted identity sets, raw credential fields and malformed hashes fail closed.

### Planning, migration and rollback

src/lifecycle/planner.ts implements deterministic plans for:

- fresh install;
- idempotent install;
- supported upgrade;
- repair/reconcile;
- exact anchor-backed rollback;
- preserve-by-default uninstall;
- explicit selected-data removal;
- reinstall.

Every schema upgrade requires an exact contiguous migration chain. Downgrade without an exact compatible recovery anchor is refused. Project contents are never a lifecycle-owned deletion category.

### Execution and interruption safety

src/lifecycle/engine.ts implements:

- stale-installation identity recheck after plan review;
- single active/uncertain lifecycle lock;
- typed driver preflight;
- preservation proof;
- duplicate/stale authority refusal;
- recovery anchor persistence before upgrade mutation;
- per-step partial-mutation journals;
- credential preservation by reference or explicit reauthorization;
- exact final release/health verification;
- verified rollback;
- UNCERTAIN quarantine with the lock retained when rollback is not proven;
- restart recovery from a verified anchor only.

SUCCESS is never returned for an ambiguous final state.

### Filesystem and evidence safety

src/lifecycle/safeFilesystem.ts provides:

- canonical absolute roots;
- traversal rejection;
- existing-component symlink rejection;
- private directory/file modes;
- same-directory atomic write/rename and fsync;
- hard-link refusal;
- bounded private reads with identical link/mode defenses;
- explicit allowlisted owned-tree deletion;
- preflight of the complete tree before recursive removal.

src/lifecycle/evidence.ts stores bounded identifiers, hashes safe paths instead of logging full path authority, and redacts bearer, token, GitHub, OpenAI-style and JWT credential shapes.

## Review remediation and current evidence

The initial source candidate received `FAIL_REVIEW / BOUNDED_REMEDIATION_REQUIRED` on nine concrete lifecycle/release findings. The current remediation closes all nine without weakening the safety model:

1. recovery state payloads preserve exact original state-relative paths instead of duplicating `config/` or `data/`;
2. recovery payload identity binds safe POSIX mode and rollback restores/verifies it exactly;
3. rollback quiesces any replacement runtime before prior filesystem bytes are restored;
4. fresh install refuses occupied unowned roots before lifecycle metadata can adopt/delete foreign data;
5. release payload reads reject every symlink/non-directory parent component and root escape;
6. REPAIR reconciles the lifecycle-owned install tree exactly to the signed payload and removes obsolete files;
7. UNINSTALL final verification proves runtime stopped, startup registrations disabled and no stale/duplicate authority remains;
8. release lifecycle components and OCI image component identities must match exactly;
9. release signing keys are supplied by a separately validated installer-owned `ReleaseTrustPolicy`; the untrusted package bundle cannot self-authenticate.

Strict owner-authorized self-audit then found and remediated additional lifecycle-hardening gaps before freeze:

- REPAIR now requires a recovery anchor and participates in the same proven rollback path as UPGRADE;
- UPGRADE/REPAIR execute an explicit `QUIESCE_RUNTIME` mutation before migration/install-tree changes;
- recovery anchors accept only `install/**`, `state/config/**`, and `state/data/**` payload namespaces and refuse lifecycle ownership metadata targets;
- all recovery payload files, digests, sizes, safe modes and parent-directory topology are verified before rollback stops the runtime or rewrites bytes;
- release payload bytes are reverified immediately before clearing the owned install tree, closing the preflight-to-mutation package TOCTOU window;
- corrupted recovery material fails before rollback mutation while the lifecycle operation remains honestly `UNCERTAIN` and locked for intervention.

The tests use deterministic fakes and disposable temporary roots only. They do not access real provider credentials, Task Scheduler, Docker, models, customer projects or production QuaranGate state.

Current exact validation on the latest remediation bytes:

- all P9 unit/integration tests: `92/92 PASS` across `9/9` files;
- repository full unit corpus: `2673/2673 PASS` across `99/99` files;
- TypeScript typecheck: PASS;
- build: PASS;
- `git diff --check`: PASS;
- added production source shell/child-process/Docker-socket/privileged surface scan: PASS;
- package lock matches the accepted dependency tree byte-for-byte; validation used that existing local dependency tree only and performed no network install.

Permanent regressions cover the nine original findings plus recoverable repair failure, runtime quiesce ordering, bounded recovery namespaces, verify-before-rollback mutation and signed-payload pre-mutation revalidation.

## Security impact

Current P9 remediation adds no Docker socket exposure, privileged container, public port, arbitrary host command API, raw-secret persistence, automatic remote exposure, capability addition or second authority system. The production release verification boundary now becomes stricter because signing trust is rooted in product/installer policy rather than release-supplied keys.

## Remaining qualification boundary

Source remediation validation is complete but this document does not claim final product release qualification. Still pending:

- immutable remediation freeze and owner-authorized strict self-audit receipt;
- transplant/rebase onto the then-current accepted canonical source followed by full post-integration validation;
- final release manifest/package regeneration against that accepted source;
- trusted signed Windows package build using the owner release-signing credential/toolchain;
- live Windows/WSL fresh-install, repair, upgrade, rollback, uninstall/reinstall and interruption-recovery rehearsal;
- P10/A9 and P11 release qualification.

## Owner-authorized source acceptance receipt

Verdict: `OWNER_AUTHORIZED_SELF_AUDIT_PASS / P9_SOURCE_REMEDIATION_ACCEPTED`.

This verdict is deliberately not labeled independent review. It applies to source remediation only and does not claim signed-Windows-package or live production lifecycle acceptance.

Immutable remediation source:

- commit: `3464847df8704aa4a55d65f7a76a68e600af4644`;
- parent: `22f15cf6a9c1d192b9554d3572b011da7d276f26`;
- subject: `fix(p9): harden lifecycle release remediation`;
- patch SHA-256: `e29f20a796cf0a7bbecb8c34273cbe2cdc332179abac814d1d525d538cab7be2`;
- path/status SHA-256: `c078d51143f3f1213e64af0da7bccc2cfb3d8dabfaf22f7c67ec9956c92bb3ff`;
- content-manifest SHA-256: `8ba606fda0173d28da9a428864a99a11f9334204077c0c7b29ad10c3382b73bf`;
- remediation path count: `11`.

Immutable replay on that exact commit:

- all P9 unit/integration: `92/92 PASS` across `9/9` files;
- repository full unit: `2673/2673 PASS` across `99/99` files;
- typecheck: PASS;
- build: PASS;
- commit diff-check: PASS;
- temporary dependency symlink removed after validation; worktree clean; staging empty.

Next source gate: transplant the complete P9 chain onto the then-current accepted canonical source and repeat integration validation before canonical promotion.

---

## Current-line production-install bridge remediation — 2026-09-18

### Authority and scope

- Writer lane: `fix/p9-production-install-gpt`
- Isolated worktree: `/workspace/QuaranGate-p9-production-install-gpt`
- Exact current-line base at remediation start: `2a576f2d8ce47f680ca3f102aa39dc13b0dc1315`
- Exact base tree: `fcb8cfc30a913017a26f603bcff27c8f600f30b2`
- Canonical ref remained at that exact base during source work.
- Accepted owner-host P10 runtime/evidence was not mutated by this lane.
- This section records **source qualification only**. A signed Windows package, Authenticode, live production lifecycle qualification, provider qualification, P10/P10-V and P11 are not claimed.

### Gap found against the P10 release boundary

Fresh reconciliation against the P10 runbook proved that the historical P9 source intentionally stopped after owner review at `PACKAGE_APPLY_DEFERRED_RELEASE_GATE`. That was safe for the historical source candidate but insufficient for the release product because P10 step 1 requires a cryptographically frozen P9 release identity and an installable signed Windows package before live qualification starts.

The current-line audit also found that production apply lacked a concrete host platform and fresh runtime-configuration bridge. A production package therefore could not honestly turn the reviewed plan into the exact WSL/Compose runtime required by QuaranGate.

### Current-line remediation

The current-line candidate adds the missing production bridge without creating a second authority system:

1. **Exact production release profile.** `src/installer/productionRelease.ts` requires exactly `docker-authority`, `executor`, `gateway`, and `projects-work`, immutable source-bound image identities, and the complete owner-facing/runtime control payload including both Windows setup entrypoints.
2. **Verified production plan/apply.** `src/installer/cli.ts` retains non-mutating source `plan` and adds fixed-argument `plan-production` / `apply-production`. Production planning verifies the manifest, detached Ed25519 proof, independently supplied installer-owned trust policy, complete payload bytes and production profile **before** owner review. Apply repeats release verification, re-probes the host, rebuilds the plan and requires the exact reviewed digest and consent set before mutation.
3. **Typed host authority.** The reviewed install plan binds the observed WSL distribution and runtime username/UID/GID. Apply cannot silently target a different WSL/runtime identity.
4. **Fresh runtime configuration.** `src/installer/runtimeConfig.ts` produces private atomic `.env`/YAML/project-Compose files and a private Kiro placeholder from the reviewed plan and verified release. Raw owner credentials are not persisted in normal config; the owner API key is returned once after a successful install while only its hash is written to client configuration.
5. **Activation sequencing.** Fresh package apply refuses pre-activation of Kiro, Copilot, Ollama, GitHub, IDE or remote access. Those remain later configure/provider/GitHub/IDE qualification steps rather than being silently enabled during install.
6. **Concrete WSL production platform.** `src/installer/wslProductionPlatform.ts` uses fixed argv and bounded output/timeouts, refuses pre-existing same-name authority during fresh install, reconciles the fixed Windows startup registration, starts/stops only installed production scripts and verifies exact managed container/image identities.
7. **Bounded runtime/startup scripts.** Production start verifies local immutable image bindings and uses `--no-build --pull never`. Partial newly managed runtime is removed on any post-start validation failure through an EXIT cleanup contract. Windows startup scripts use a fixed task identity and limited run level.
8. **Owner-facing signed wizard.** `QuaranGate-Setup.ps1` requires release manifest/signature/trust inputs, displays the exact verified release + host + authority + consent review, and invokes `apply-production` only after owner approval. The RemoteSigned `.cmd` launcher forwards the release arguments. Temporary answer/consent documents are removed after use.

### Pre-freeze evidence

The current-line bridge went through incremental focused qualification and then a fresh exact-byte pre-freeze replay after the Windows launcher and documentation reconciliation.

Final pre-freeze replay on the complete candidate:

- all P9 unit/integration: **108/108 PASS across 14/14 files**;
- repository full unit corpus: **3173/3173 PASS across 163/163 files**;
- TypeScript typecheck: **PASS**;
- build: **PASS**;
- security invariants: **16/16 PASS across 12 Compose files and 7 Dockerfiles**;
- fixed-seed fuzz: **PASS**, seed `1374718481`, **30,067 executions**, **395 coverage ranges**;
- production runtime shell syntax: **PASS**;
- `git diff --check`: **PASS**;
- package-lock SHA-256 remained exact at `5ad727697de394442f04514bc391e3367af98d7efb5fc822ef3d87d1cda1b570`;
- full candidate-path credential/secret-shape scan, including new/untracked files: **PASS**;
- full candidate-path forbidden-authority scan, including new/untracked files: **PASS**.

These are pre-commit source qualification results. The immutable-candidate replay must still be repeated after freeze and must bind the exact commit/tree; this section does not predeclare that later verdict.

### Freeze finding and R1 remediation

The first immutable current-line freeze, `80f34d003fb4006cdffa937a610cade15d209018`, is preserved as **NOT ACCEPTED**. Its commit metadata exposed a packaging defect before immutable replay: `scripts/production-runtime-start.sh` was tracked as mode `100644` even though the production release profile requires that installed entrypoint to be executable. Canonical was not moved.

R1 changes only the tracked executable mode of that start script, adds a regression that requires both production runtime entrypoints to carry executable permission bits, and records this finding. The immutable R1 candidate must still pass the complete exact-commit replay before review/promotion.

### Remaining external/release boundary

Even after source freeze/promotion, P9 is not a live release PASS until the external release artifacts and lifecycle rehearsal exist. Still required:

- immutable current-line candidate freeze and review;
- guarded canonical promotion only if the canonical ref has not drifted;
- exact P9 release manifest and detached Ed25519 proof for the frozen release candidate;
- independently supplied installer trust policy;
- a real signed `QuaranGate-Setup.exe` / trusted Windows packaging result and SHA-256;
- live Windows 11/WSL2 install/restart/upgrade/repair/rollback/uninstall/reinstall evidence on a disposable qualification environment;
- downstream provider/IDE/GitHub qualification and P10/A9;
- P10-V and P11.

No source test in this section substitutes for those external gates.
