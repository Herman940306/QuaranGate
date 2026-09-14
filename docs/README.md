# QuaranGate Documentation

This directory is organised by **how the documentation is used**, so operators, developers, reviewers and support staff can find the right source quickly.

## Documentation map

| Area | Purpose | Start here |
|---|---|---|
| [`architecture/`](architecture/) | System architecture, trust zones, target model and structural contracts | [`ARCHITECTURE.md`](architecture/ARCHITECTURE.md) |
| [`backend/`](backend/) | Agent Control Plane, GitHub Control Plane and local-model/backend contracts | [`AGENT_CONTROL_PLANE.md`](backend/AGENT_CONTROL_PLANE.md) |
| [`frontend/`](frontend/) | QuaranGate Console implementation, product specification and U1 intent | [`CONSOLE.md`](frontend/CONSOLE.md) |
| [`ide/`](ide/) | IDE Session Control architecture, feasibility evidence and adapter programs | [`IDE_SESSION_CONTROL.md`](ide/IDE_SESSION_CONTROL.md) |
| [`operations/`](operations/) | Deployment, lifecycle, remote-owner and installer/upgrade operations | [`OPERATIONS.md`](operations/OPERATIONS.md) |
| [`user-guides/`](user-guides/) | End-user/client setup, Console operation, support and troubleshooting | [`CONSOLE_OPERATIONS_SUPPORT_MANUAL.md`](user-guides/CONSOLE_OPERATIONS_SUPPORT_MANUAL.md) |
| [`security/`](security/) | Security model, threat boundaries and egress evidence | [`SECURITY.md`](security/SECURITY.md) |
| [`reference/`](reference/) | MCP function catalog and compatibility/reference material | [`MCP_TOOL_REFERENCE.md`](reference/MCP_TOOL_REFERENCE.md) |
| [`testing/`](testing/) | Current and historical validation summaries | [`TEST_RESULTS.md`](testing/TEST_RESULTS.md) |
| [`audits/`](audits/) | Frozen phase/audit evidence retained as historical records | [`PHASE_A0_FORENSIC_READINESS_AUDIT.md`](audits/PHASE_A0_FORENSIC_READINESS_AUDIT.md) |

## Frontend documentation

For QuaranGate Console work, use this sequence:

1. [`frontend/CONTROL_CENTER.md`](frontend/CONTROL_CENTER.md) — owner-approved U1 product intent.
2. [`frontend/CONSOLE_PRODUCT_SPECIFICATION.md`](frontend/CONSOLE_PRODUCT_SPECIFICATION.md) — full functional specification.
3. [`frontend/CONSOLE_FRONTEND_ARCHITECTURE.md`](frontend/CONSOLE_FRONTEND_ARCHITECTURE.md) — frontend architecture, security and data flow.
4. [`frontend/CONSOLE.md`](frontend/CONSOLE.md) — current implementation overview.
5. [`user-guides/CONSOLE_OPERATIONS_SUPPORT_MANUAL.md`](user-guides/CONSOLE_OPERATIONS_SUPPORT_MANUAL.md) — operator/support manual.
6. [`reference/MCP_TOOL_REFERENCE.md`](reference/MCP_TOOL_REFERENCE.md) — complete MCP function reference and use cases.

## Backend documentation

- [`backend/AGENT_CONTROL_PLANE.md`](backend/AGENT_CONTROL_PLANE.md) — durable agent jobs, sandbox/evidence/apply lifecycle.
- [`backend/GITHUB_CONTROL_PLANE.md`](backend/GITHUB_CONTROL_PLANE.md) — governed GitHub App authority and repository operations.
- [`backend/O1_MODEL_QUALIFICATION.md`](backend/O1_MODEL_QUALIFICATION.md) — local Ollama qualification and activation boundary.

## Operations and support

- [`operations/OPERATIONS.md`](operations/OPERATIONS.md) — operator runbook for build, run, health and recovery.
- [`operations/REMOTE_OWNER_ORCHESTRATION.md`](operations/REMOTE_OWNER_ORCHESTRATION.md) — owner-host/remote-owner operational pattern.
- [`operations/INSTALLER_PRODUCTIZATION.md`](operations/INSTALLER_PRODUCTIZATION.md) — D1/D2 install, upgrade, repair, rollback and uninstall requirements.
- [`user-guides/CLIENT_SETUP.md`](user-guides/CLIENT_SETUP.md) — client connection/setup guidance.
- [`user-guides/CONSOLE_OPERATIONS_SUPPORT_MANUAL.md`](user-guides/CONSOLE_OPERATIONS_SUPPORT_MANUAL.md) — day-to-day Console operation and support triage.

## Database and persistence documentation

There is currently **no standalone database manual**. Durable job/evidence persistence semantics live with the backend contracts and frozen A6 audit evidence. If database administration, schema migration or backup/restore becomes a distinct operator surface, create `docs/database/` at that point instead of duplicating backend truth prematurely.

## Historical evidence rule

Files under `audits/` are frozen historical evidence. They are intentionally not rewritten merely to make old path references look current. Current documentation and source references must use the organised paths above.

## Naming convention

- Directories use lowercase functional names (`frontend`, `backend`, `operations`).
- Existing document filenames remain uppercase/snake-case to preserve recognisability and Git history.
- New documentation should be placed in the functional directory that owns its primary audience/use case, not at the `docs/` root.
