# BE0 Handoff

Status: implementation candidate for orchestrator audit. **Not accepted.**

## Identity

Repository: QuaranGate

Canonical source at branch creation:
- branch: `integrate/quarangate-forward`
- HEAD: `52b78f1723e798aeec80c020065846b1b0efeabe`
- tree: `6e09255046dff55ae7c1bf313dfeed0eeaa16d81`
- canonical status: clean
- canonical staging: empty

BE0 lane:
- branch: `feature/qg-product-be0-contract-foundation-gpt`
- worktree: `/home/herman/projects/QuaranGate-product-be0-gpt`
- base: exact canonical HEAD above

Approved roadmap-only input inspected:
- branch: `docs/qg-cross-project-concurrency-roadmap-gpt`
- commit: `f858039545d96f8f2895d75082c488250855eef0`
- tree: `ed86be6b07c19bf8d2f92f14da201de4c5f6eedc`
- parent: `52b78f1723e798aeec80c020065846b1b0efeabe`

That roadmap branch was not merged into BE0.

## Existing backend

Proven reusable core:
- 45-tool MCP contract:
  - 18 direct target/filesystem/terminal/Git/process operations;
  - 9 Agent Control Plane;
  - 17 GitHub Control Plane;
  - 1 Control Center query.
- API-key and OAuth gateway auth map to one Principal model.
- Principal carries scopes and explicit target/project/backend/profile/GitHub grants.
- durable ACP SQLite and separate IDE Session SQLite.
- guarded evidence/diff/apply/discard boundary.
- durable project/worktree live-writer arbitration.
- current same-origin Console/MCP architecture.
- bounded Control Center metadata/read model.

## Product delta

Genuinely new product layers include:
- Keycloak product identity/session;
- PostgreSQL product relational platform;
- org/workspace/membership/roles/overrides;
- explicit product-user → QuaranGate principal mapping;
- OpenBao secret custody;
- provider configuration and Agent Profiles;
- persisted approvals/autonomous policy;
- collaboration/event infrastructure;
- durable long-window statistics;
- audio meetings;
- security assessment platform;
- Tool/Skill Creator;
- cross-project execution concurrency fabric.

## Cross-project concurrency conclusion

Current source explicitly serializes ACP execution globally in `AgentJobStore.claimNext()`.

Existing safety already provides:
- project identity on jobs;
- per-project writer accounting;
- project apply exclusion/quarantine;
- live-writer leases by project/worktree;
- IDE project/worktree/session bindings.

BE1A should therefore relax unnecessary scheduler serialization while retaining those narrower safety invariants.

It must not solve same-project multi-writer coordination.

## Contracts created

- `docs/product-platform/CURRENT_BACKEND_CAPABILITY_INVENTORY.md`
- `docs/product-platform/PRODUCT_BACKEND_DELTA_MATRIX.md`
- `docs/product-platform/PRODUCT_SERVICE_BOUNDARIES.md`
- `docs/product-platform/PRODUCT_AUTHORITY_MODEL.md`
- `docs/product-platform/PRODUCT_API_CONTRACTS_V0.md`
- `docs/product-platform/PRODUCT_EVENT_CONTRACTS_V0.md`
- `docs/product-platform/PRODUCT_DATA_OWNERSHIP_V0.md`
- `docs/product-platform/BACKEND_IMPLEMENTATION_SEQUENCE.md`
- `docs/product-platform/LEGACY_NORTHSTAR_CARRY_FORWARD.md`
- `docs/product-platform/BE0_HANDOFF.md`

## Source changes

Documentation only under `docs/product-platform/`.

No runtime source, root shared architecture file, deployment composition, database migration, credential, Compose service or listener is changed.

No optional source skeleton was created because current repository ownership does not establish a non-conflicting product-backend source root strongly enough for BE0.

## Proposed integration changes

Do not edit shared root files from this lane.

After orchestrator/independent acceptance, integration may update shared architecture/roadmap documentation to reference the accepted product-platform contracts and common-base identity.

## Contradictions / risks

1. The old continuation handoff is chronological and contains superseded CURRENT_NEXT blocks. The newest applicable control block must win.
2. Canonical source used for this product lane is the orchestration-approved `52b78f1...` base even though older project-control sections record later historical North-Star canonical points. Product orchestration must explicitly reconcile this before final integration rather than silently assuming ancestry/equivalence.
3. ACP execution is globally serialized today; BE1A changes scheduler semantics and is security-sensitive.
4. Current live-writer lease identity is project/worktree based and must not be weakened by broader resource leasing.
5. Current Control Center statistics are bounded/in-memory and cannot satisfy durable 24h/7d/30d product analytics.
6. Product role/identity work risks privilege amplification unless every request intersects with QuaranGate Principal authority.
7. Secret custody, audio retention/consent, attachment retention, and destructive security workflows require explicit future product/security/privacy decisions.
8. P11-D lacks a detailed authoritative contract.

## Proposed next backend waves

1. BE1 product identity/session.
2. BE1A cross-project concurrency once BE1 identity/session contracts are stable.
3. BE2 PostgreSQL product data and BE3 principal mapping may proceed alongside BE1A only with isolated worktrees and explicit non-overlapping file/resource ownership.

## Governance

This BE0 lane:
- does not mutate canonical;
- does not merge;
- does not push;
- does not deploy;
- does not modify running QuaranGate services;
- does not create Keycloak/PostgreSQL/OpenBao/Zabbix/Tempo infrastructure;
- does not broaden MCP/host/Docker authority.

Stop for orchestrator audit after validation.
