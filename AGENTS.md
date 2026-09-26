# Agent operating contract

This repository is security-sensitive. AI agents must preserve QuaranGate's governed-authority model rather than optimizing only for task completion.

## Before work

1. Verify repository/worktree identity, branch, HEAD, status, staging, and intended scope.
2. Determine whether another writer owns the worktree. If yes, stop mutation and use a separate isolated lane.
3. Read the closest current design/security/operations documentation for the affected area.
4. Identify the security or authority boundary touched by the change.

## During work

- Make the smallest change that solves the proven problem.
- Do not broaden host, Docker, filesystem, network, credential, provider, or live-source authority as a workaround.
- Do not bypass existing authentication, authorization, attestation, stale-state, evidence, writer-arbitration, or promotion controls.
- Never put real secrets or credentials in fixtures, documentation, commit messages, or logs.
- Preserve historical audit records unless the task explicitly creates a new historical record.
- Treat environment failures as environment failures; do not weaken source security to make a constrained runner green.

## Before handoff

Run the checks appropriate to the exact change. At minimum consider typecheck, focused tests, full unit tests, build, `git diff --check`, and applicable security/release gates. Report exact results and limitations. Do not self-label an unreviewed candidate as accepted.

If a task would require destructive testing, production mutation, credential use, paid-provider entitlement, or a decision that changes product authority, stop and request explicit owner authorization.


## Mandatory frontend visual source of truth

For any task that reads, reviews, tests, edits, or generates frontend code, styling, routes, components, screenshots, visual evidence, or frontend documentation, first read docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md in full.

That document is the owner-directed normative contract for frontend visual completion. Functional/source acceptance does not imply final visual acceptance. Do not mutate frontend source before reading it. Preserve accepted security/authority behavior while moving the rendered product toward the approved QuaranGate design.

Every frontend handoff must include:

FRONTEND_VISUAL_SOT_READ=YES
FRONTEND_VISUAL_SOT_PATH=docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md
DESIGN_CONFORMANCE_SCOPE=<checked or changed scope>

If the source-of-truth file is unavailable, stop frontend mutation and report the missing contract.
