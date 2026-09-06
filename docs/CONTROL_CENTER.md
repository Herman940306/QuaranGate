# QuaranGate Control Center — U1 Product Intent

**Status:** Owner-approved pre-production requirement; not implemented.

**Roadmap role:** U1 must close before A9 production hardening begins.

## Product goal

QuaranGate must be understandable and usable by a nontechnical user without requiring routine knowledge of Docker Compose, MCP schemas, container IDs, Git hashes, WSL paths, OAuth metadata, raw scope strings, network namespaces or YAML files.

The GUI is a human-facing control plane over the same governed backend. It must **not** become a second authority path, bypass policy, infer permission from convenience, or replace machine-derived evidence with UI claims.

Before U1 implementation starts, perform a fresh forensic audit of the entire then-current repository and accepted feature surface. Screen design, terminology and workflows must be based on real capabilities at that point. This document freezes product intent and a baseline information architecture; it is not permission to build stale mockups before that audit.

## UX principles

- Human language first; exact technical evidence remains available under advanced/details views.
- One obvious place for every human decision or approval.
- Current source state, deployed runtime state and pending/unaccepted state must remain distinguishable.
- Security refusals should explain what happened and what safe action is available without disguising the underlying code/error.
- High-impact actions must make authority and affected resource clear before execution.
- Normal users should not need to edit YAML or invoke terminal commands for supported product workflows.
- Advanced users must still be able to inspect exact IDs, revisions, scopes, evidence and runtime identity.

## Baseline tabs

The final audit may refine naming or grouping, but the following capabilities are owner-approved as beneficial baseline surfaces.

### Home
Overall health, connected clients, active projects, current work, pending approvals, alerts, local-model status, IDE sessions, backup/recovery state and remote-access status.

### Projects
Project identity, Git state, read/write policy, permitted agents, guarded paths, current work, IDE sessions, recent changes and attached GitHub repository.

### Agents
Kiro, Copilot, local models and future backends: availability, role, authority, active job/session, provider/model identity, last success and failures.

### Work / Jobs
Current and historical governed work with human lifecycle states. Each job exposes request, agent, changed files, tests, evidence, risk and disposition.

### Review & Approvals
A single decision inbox for apply approval, guarded-path decisions, project enrollment, permission changes, IDE-session enrollment, GitHub writes and other human-gated actions.

### IDE Sessions
After I1-I6: exact IDE, project/workspace, branch/worktree, agent, session, connection age and mutation authority, with safe session controls.

### GitHub
Accounts, repositories, branches, pull requests, issues, statuses and reviews through the governed GitHub Control Plane. The UI must not invent merge, force-push, delete or arbitrary API authority.

### Local AI / Models
Plain-language local-inference status: model, health, local execution, cloud-fallback state, allowed roles and resource usage, with exact identities in advanced view.

### Monitoring
Gateway, executor, workers, targets, IDE adapters, local inference, GitHub broker, ingress and queue/activity health.

### Statistics
Tasks completed/failed, approvals/rejections, files changed, tests/pass rate, rollback/quarantine counts, agent/model usage, task duration, local-vs-cloud execution where applicable, GitHub operations and project activity. Analytics must not expose secrets or prompt contents.

### Security & Access
Human-readable client/user authority, project access, read/write, GitHub authority, IDE authority, Docker-boundary health, local-model privacy and credential health, with exact scopes in advanced view.

### Audit & Evidence
Chronological requests, policy decisions, sandbox work, tests, approvals and applied/discarded outcomes. Machine-derived evidence remains authoritative.

### Recovery & Backups
Backup state, recovery checkpoints, quarantines, uncertain/failed applies, startup recovery and restore operations.

### Settings
Projects, clients, agents, models, GitHub, IDEs, remote access, startup, retention, backups and resource limits without routine direct YAML editing.

## Example translation rule

Technical errors remain inspectable, but the default user message should explain impact and safe next action. For example:

> This change cannot be applied because the project changed after the AI created it. Review the newer version and retry.

## U1 acceptance direction

U1 must prove that the GUI uses governed APIs rather than privileged side channels, cannot broaden backend authority, preserves fail-closed behavior, accurately represents live/source/evidence state, exposes owner decisions clearly, is usable by a nontechnical test user, and retains advanced machine-derived evidence for expert diagnosis.
