# Current Backend Capability Inventory

Status: BE0 evidence-backed inventory. This document is descriptive, not acceptance.

## Source binding

- Canonical source inspected: `integrate/quarangate-forward`
- Base commit: `52b78f1723e798aeec80c020065846b1b0efeabe`
- Base tree: `6e09255046dff55ae7c1bf313dfeed0eeaa16d81`
- BE0 worktree: `QuaranGate-product-be0-gpt`
- BE0 branch: `feature/qg-product-be0-contract-foundation-gpt`

Current source and executable state override historical roadmap prose where they differ.

## 1. Gateway and authentication

### API-key path
Implemented. `src/gateway/auth/apikeys.ts` hashes submitted credentials with SHA-256 and resolves them to enabled principals from trusted gateway configuration. Raw keys are not stored in the Principal model.

### OAuth path
Implemented as an OAuth 2.1 façade in `src/gateway/auth/oauth.ts`:
- authorization code + PKCE S256;
- exact redirect URI matching;
- RFC 8707-style resource binding;
- opaque access/refresh values persisted only by hash;
- rotating refresh tokens;
- dynamic client registration with bounded client count and lifetime.

OAuth maps back to the same QuaranGate Principal model as API-key authentication. It does not create a second operational authority model.

### Principal and grants
`src/gateway/config.ts` defines Principal with:
- scopes;
- target grants;
- agent project/backend/profile grants;
- GitHub account/project grants;
- optional per-principal rate limit.

The effective authority decision is server-side. Possession of product/UI state does not grant operational authority.

### Request admission, audit, telemetry, rate limiting
Current gateway source includes request admission, structured audit, request telemetry and per-principal rate limiting. The Control Center surfaces only safe metadata and does not expose prompts, tool arguments, file contents, command output, credentials or raw response bodies.

### Same-origin Console/MCP
The existing Console is mounted through the gateway and preserves the same-origin relationship. `consoleWeb.ts` applies Console-specific security headers. No second public listener is required for the existing surface.

## 2. Direct operational MCP surface

Current documented public surface is 45 tools total.

Direct target operations: 18 tools covering:
- target list/inspect/log/start/stop/restart;
- filesystem list/stat/read/search/write/patch/delete;
- bounded terminal execution;
- Git status/diff/log;
- process listing.

The executor enforces workspace-relative path confinement and bounded execution. `src/executor/execops.ts` currently applies global and per-principal concurrency caps for in-target execs.

## 3. Agent Control Plane

Nine tools are implemented:
- agents_list
- agent_projects
- agent_dispatch
- agent_status
- agent_result
- agent_diff
- agent_apply
- agent_cancel
- agent_discard

### Lifecycle
Durable lifecycle states and transitions are defined in `src/shared/agents.ts`. COMPLETED is explicitly distinct from APPLIED. Failure states and dispositions are terminal and a retry is a new job.

### Persistence
The executor owns a durable SQLite Agent job store. Current schema also carries:
- provider/session state;
- project apply state;
- apply attempts/journal;
- live-writer lease state;
- immutable artifact/evidence references.

### Evidence and apply boundary
Implementation output remains sandboxed until reviewed. `agent_diff` exposes canonical verified change evidence. `agent_apply` re-verifies stored evidence and fails closed on stale/dirty/guarded/mismatched live state. Caller-supplied patch text or host paths are not accepted.

### Writer safety
Current source already has durable live-writer arbitration keyed by project/worktree and owner identity. ACTIVE/UNCERTAIN writer state blocks conflicting mutation. This must be preserved through BE1A.

### Current backend states
- Kiro: real implemented ACP backend in source; live availability remains environment/entitlement dependent.
- Ollama: governed read-only local-model path exists and remains subject to final live requalification.
- Copilot: source implementation exists in current tree, but live provider acceptance remains an explicit later gate.
- Session continuity: source implementation exists, but current executable Control Center reports it as not fully qualified.

### Current global scheduling limitation
`AgentJobStore.claimNext()` explicitly refuses to claim a queued job while any agent job is active. This is the primary BE1A global-serialization assumption. Writer rules are already recorded separately so the scheduler can later relax global serialization without losing writer exclusion.

## 4. GitHub Control Plane

Seventeen GitHub tools are registered, spanning:
- repository/branch/commit discovery;
- pull requests, files, reviews and review comments;
- issues/comments;
- status/check compatibility reads;
- exact-HEAD bounded push;
- PR create/update/review.

Authority comes from trusted GitHub App/account mappings and explicit local project mappings. Arbitrary remote URLs, force push, default/protected branch push, tag push, deletes and merge are not expressible through the public QuaranGate contract.

## 5. Control Center

One `control_center_query` tool exposes bounded metadata views:
- summary
- activity
- authority
- topology
- egress
- providers
- incidents
- statistics
- capabilities
- resources
- recovery

Current activity retention is in-memory only: maximum 2,048 entries and 24 hours, with bounded query responses. Current statistics are therefore operational-window metrics, not durable 24h/7d/30d analytics.

Generic Docker resource enumeration is intentionally not public.

## 6. Persistence inventory

Current durable stores include:
1. Agent Control Plane SQLite job/session/apply/writer state.
2. IDE Session Control SQLite registry and operation/event metadata.
3. Gateway OAuth token/client JSON state.
4. Gateway trusted client/principal configuration.
5. Installer/runtime-owned private configuration and credential files.
6. Agent evidence/artifact content and release evidence retained outside the logical product DB.

There is no current general-purpose product relational database for users, organizations, workspaces, collaboration, preferences or product notifications.

## 7. Security boundaries

Current source preserves:
- gateway without raw Docker authority;
- executor-side governed Docker authority;
- strict workspace confinement;
- bounded egress/provider policy;
- private credential injection rather than prompt/file disclosure;
- immutable artifact/evidence review before apply;
- project/worktree live-writer arbitration;
- quarantine on uncertain mutation outcomes;
- no caller-controlled Docker options, remote URLs or host paths in public contracts.

## 8. BE7 audio/meetings owner-policy source state

Current recovered BE7 source extends the earlier metadata-only foundation with privacy-gated meeting operations. The source now includes recording opt-in, owner attestation, recording start/stop, transcript export, transient-audio handling, meeting-export audit metadata, bounded transcript-retention policy, LOCAL_ONLY transcription classification and anonymous speaker-label validation.

The enforced policy is intentionally restrictive:
- recording cannot start without explicit per-meeting opt-in;
- current owner attestation and persistent-visual notice acknowledgement are required;
- raw audio is transient and cleanup must be verified;
- transcript persistence requires an explicit bounded workspace retention policy;
- generated summaries/action items are ephemeral-only and carry `executionAuthority=false`;
- STT is LOCAL_ONLY;
- speaker labels are anonymous `Speaker A` / `Speaker B` style only;
- transcript export requires the narrow product permission, is workspace-scoped and emits metadata-only audit records.

These are source-level capabilities only. Live PostgreSQL/STT/audio/runtime qualification remains separate and is not claimed by this inventory.

## 9. Reuse conclusion

The mature MCP/ACP/GitHub/Control Center core is reusable. BE0 recommends an additive product-platform layer around it rather than replacement.

The highest-value reuse boundaries are:
- existing MCP tools for operational pages;
- ACP for governed AI jobs;
- GitHub plane for trusted repository operations;
- Control Center for current-state metadata;
- Principal/scopes/resource grants as the final operational authority model.

New product identity, relational product data, collaboration, secrets brokering, long-horizon analytics and security-assessment orchestration should integrate through adapters and new services without broadening these authority cores.
