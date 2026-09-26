# BE1A Security Analysis

## Preserved authority boundaries

BE1A changes scheduling concurrency only. It does not broaden Docker authority, host-path selection, image/mount/network selection, credentials, project registry authority, apply authority, artifact authority, or live-writer admission.

The existing apply/live-writer system remains independently authoritative. A BE1A execution lease cannot grant apply permission.

## Spoof resistance

- Dispatch resource claims are derived from trusted project registry data.
- Writer worktree claims are derived from the registered project worktree id.
- Caller-shaped resource/concurrency fields are ignored because they are not part of the dispatch contract.
- Store validation independently rejects malformed, duplicate, oversized, path-like, or selector-like resource identities.
- Trusted config parsing rejects invalid concurrency bounds and invalid resource ids.

## Cross-project isolation

Scheduling state is partitioned by durable project id. The scheduler never substitutes caller paths/resources for project identity. Control Center execution metadata is filtered at the gateway against principal project grants.

No BE1A read model includes prompts, terminal output, credentials, raw Docker configuration, provider payloads, or arbitrary host paths.

## Lease races

Lease acquisition occurs in the same `BEGIN IMMEDIATE` transaction as QUEUED -> PREPARING. A partial unique index prevents two ACTIVE/UNCERTAIN owners of the same resource.

BE1A R1 makes successful completion durable lease settlement atomic with VALIDATING -> COMPLETED. Startup reconciliation repairs historical terminal+ACTIVE rows using an explicit terminal-state policy: proof-safe states release only their exact lease ids/job ids; CANCELLED and FAILED_INFRASTRUCTURE become UNCERTAIN. Existing UNCERTAIN leases remain untouched. There is no timer-based expiry and no cross-job release.

## Global-exclusive safety

A global-exclusive candidate cannot start while any execution lease is ACTIVE or UNCERTAIN. Its machine-global lease then blocks all later candidates until safely settled.

## Negative-test coverage

BE1A focused tests cover:

- caller-shaped execution resource/concurrency fields ignored;
- path-shaped resource identities rejected;
- invalid configured concurrency rejected;
- same protected resource serialized;
- distinct resources admitted concurrently;
- same owner-host scope serialized while distinct owner-host scopes coexist;
- crash recovery preserves UNCERTAIN exclusion;
- explicit evidence-bound UNCERTAIN settlement;
- project-scoped cancellation isolation;
- snapshot omits trusted host path/prompt content.

BE1A R1 additionally covers atomic COMPLETED lease settlement, stale terminal ACTIVE reconciliation, FAILED terminal reconciliation, CANCELLED -> UNCERTAIN classification, active crash preservation, idempotence, no cross-job release, conflict unblocking, and principal-filtered global-exclusive truth without hidden project/job leakage.

Existing ACP tests continue to cover cross-principal job ownership and cancellation authorization. Existing live-writer/apply suites remain required regression gates.
