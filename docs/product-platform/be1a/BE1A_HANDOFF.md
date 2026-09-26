# BE1A Handoff — Cross-Project Concurrency / Execution Fabric

## Governance

Implementation worker only. This candidate must not self-accept.

## Base

Accepted compatible backend base selected after direct forensic comparison:

- commit: `e0d7458724dae6bf85d8fb0493c71963172ab865`
- tree: `ba88838704a714d3dc8c0051c8d9e42104704c54`
- subject: `fix(product): preserve unavailable BE6 provider health`

BE7 was not used as the base because the directly inspected BE7 worktree was dirty/privacy-gated and its own validation evidence identified this BE6 R1 commit as the accepted base.

## Implementation lane

- isolated clone: `/workspace/QuaranGate-product-be1a-gpt`
- branch: `feature/qg-product-be1a-concurrency-gpt`

A self-contained clone is used instead of a linked worktree because the existing linked-worktree metadata inside the governed container points to host-only `/home/herman/...` gitdirs. No existing worktree metadata was rewritten.

## Implemented

- trusted execution limits and per-project queue cap;
- deterministic project-fair scheduler;
- up to four concurrent projects by default;
- same-project serialization retained;
- automatic writer worktree resource claims;
- durable logical resource leases with SQLite exclusion;
- global-exclusive machine lane;
- crash/shutdown -> UNCERTAIN fail-closed semantics;
- evidence-bound uncertainty settlement seam not exposed through MCP;
- project-scoped cancellation behavior preserved;
- one-entry generation-invalidated safe read cache;
- principal-filtered Control Center execution-fabric read model;
- schema v10 forward migration preserving historical rows;
- focused positive/negative security tests.

## Shared test resource

Root Vitest remains serialized because the historical root wrapper shares `/tmp/q`. BE1A models such roots as trusted `temp-root` resources but this candidate does not claim the existing test harness is governed by BE1A until independently accepted/integrated.

## Validation

See `evidence/VALIDATION.txt` and `BE1A_ACCEPTANCE_MATRIX.md`.

## Acceptance

Independent review is required. Do not treat implementation-worker PASS gates as project acceptance.
