# QuaranGate Installer & Lifecycle Productization — D1/D2

**Status:** Owner-approved pre-production requirement; not implemented.

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
