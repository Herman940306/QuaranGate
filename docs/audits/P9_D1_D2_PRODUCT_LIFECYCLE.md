# P9 D1 + D2 Product Lifecycle — Isolated Source Candidate

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

## Test strategy and current evidence

The tests use deterministic fakes and disposable temporary roots only. They do not access real provider credentials, Task Scheduler, Docker, models, projects or production QuaranGate state.

Focused P9 results before broad validation:

- P9 unit tests: 50/50 PASS;
- P9 integration tests: 14/14 PASS;
- combined focused tests: 64/64 PASS;
- TypeScript typecheck: PASS.

Covered negative and recovery behavior includes:

- missing/incompatible Docker and Compose;
- unreachable daemon;
- unsupported native Windows runtime;
- inadequate resources;
- permission and project authority consent;
- guarded path and raw-secret refusal;
- provider entitlement deferral;
- P7-pending IDE binding;
- GitHub wildcard refusal;
- remote opt-in/out;
- local AI resource bounds;
- strict manifest validation;
- malformed migration refusal;
- recovery-anchor integrity mismatch;
- idempotent install;
- upgrade and schema/config migration;
- preflight failure before mutation;
- partial failure with proven rollback;
- unprovable rollback -> UNCERTAIN;
- preservation proof failure;
- credential preservation or reauthorization;
- final-health rollback;
- repair/reconcile;
- exact supported rollback;
- uninstall preserve-data and remove-selected-data;
- cancelled consent;
- duplicate/stale authority refusal on reinstall;
- interruption recovery;
- traversal, symlink, hard-link and mode attacks;
- release payload integrity mismatch;
- secret redaction and evidence bounds.

Fresh broad validation results:

- full unit corpus: 2662/2662 PASS across 98/98 files;
- relevant path/redaction/config/startup regression: 105/105 PASS across 5/5 files;
- TypeScript typecheck: PASS;
- build: PASS;
- git diff --check: PASS;
- changed-path scope scan: PASS, zero out-of-scope paths;
- production-source secret-pattern scan: PASS, zero hits;
- synthetic secret strings exist only in negative redaction/refusal tests;
- forbidden authority scan: PASS, zero Docker-socket, privileged, public-listener, firewall/port-proxy, hidden-elevation or capability-addition hits;
- process-execution surface: one fixed host-readiness probe using spawnSync with shell=false and fixed executable/argument arrays;
- dependency delta: NONE; package-lock.json unchanged and no dependency fields changed.

The repository-wide integration command was also run and is truthfully not green in projects-work:

- discovered tests: 95;
- passed: 41;
- skipped: 50;
- failed: 4;
- P9 lifecycle integration: 14/14 PASS;
- ten Docker/image-backed suites were unavailable because projects-work has no Docker CLI/socket or required image;
- five service-backed suites lacked their required KEYS_ENV/runtime;
- four A6 evidence-lifecycle tests failed on the pre-existing worktreeId logical-id fixture contract.

The same four A6 failures were reproduced directly at untouched accepted forward source d720f0f912ed24f876c9e24fa47b281a58dd87b2 (8/12 PASS, 4/12 FAIL), proving they were not introduced by the P9 delta. P9 did not modify A6/P7 code to hide or repair this unrelated accepted-base regression.

This document cannot embed the SHA of the commit containing itself; the exact candidate commit and whole base..tip hashes are therefore returned as external immutable receipts without amending after handoff.

## Security impact

Expected P9 delta:

- new Docker socket exposure: none;
- new privileged container: none;
- new public port default: none;
- new arbitrary host command API: none;
- new ungoverned mutation path: none;
- new plaintext credential storage: none;
- new automatic remote exposure: none;
- new silent privilege escalation: none;
- new second authority system: none.

## Known upstream/release dependencies

- final IDE adapter inventory and package binding: PENDING_UPSTREAM_P7;
- signed Windows package build: DEFERRED_EXTERNAL_OWNER_CREDENTIAL and trusted packaging toolchain;
- live Windows/WSL lifecycle rehearsal: NOT_RUN;
- canonical/forward merge: NOT_AUTHORIZED;
- production deployment: NOT_RUN;
- independent ChatGPT review: PENDING.
