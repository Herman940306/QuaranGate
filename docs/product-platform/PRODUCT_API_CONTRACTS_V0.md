# Product API Contracts V0

This is a contract freeze for later implementation. It does not create a new listener or runtime.

## Envelope

All product APIs return either:
- `{ data, meta? }`
- or `{ error }`

Recommended metadata:
- requestId
- version/etag when mutable
- serverTime

## Typed errors

`error.code` must be one of the bounded domain classes below, with service-specific subcodes allowed:

- UNAUTHENTICATED
- FORBIDDEN
- NOT_FOUND
- STALE_VERSION
- BACKEND_UNAVAILABLE
- VALIDATION_FAILED
- RATE_LIMITED
- CONCURRENCY_LIMITED
- AUTHORITY_DENIED
- RESOURCE_DENIED
- CONFLICT
- PRECONDITION_FAILED
- INTERNAL

Errors must not echo secrets, raw provider payloads or inaccessible resource content.

## Concurrency/versioning

Mutable product records should use opaque version or strong ETag semantics.

Write requests use one of:
- `If-Match: <etag>`
- explicit `expectedVersion`

A stale write fails with STALE_VERSION and does not silently last-write-win.

## Identity/session

### GET /v0/session
Returns:
- product user identity;
- organization/workspace context;
- product roles/overrides;
- mapped QuaranGate principal id/status summary;
- safe effective-capability summary.

Does not return raw operational credentials.

### POST /v0/session/switch-workspace
Input:
- workspaceId
- expectedSessionVersion

Server re-resolves product membership and operational mapping.

## Provider configuration

### GET /v0/providers
Returns safe metadata:
- id
- kind
- owner scope
- configured boolean
- masked identifier/hint
- validation status
- updatedAt/version

Never returns secret value.

### POST /v0/providers
Input:
- provider metadata
- secretValue (optional/write-only)
- expectedVersion when updating

Secret value is transferred directly to custody handling and excluded from response/event/audit payloads.

### POST /v0/providers/{id}/validate
Creates a bounded validation operation; it does not grant the provider to ACP by itself.

## Agent Profiles

### GET /v0/agent-profiles
### POST /v0/agent-profiles
### PATCH /v0/agent-profiles/{id}
### DELETE /v0/agent-profiles/{id}

Profile fields may reference:
- backend;
- ACP profile;
- logical project/workspace;
- resource policy;
- approved capability preferences.

Actual dispatch still uses existing `agent_dispatch`.

## Operational adapter endpoints

Product adapters may expose curated calls for UI ergonomics but must delegate to existing MCP/ACP/GitHub contracts.

Examples:
- `GET /v0/operations/targets` → existing target tools
- `GET /v0/operations/jobs/{jobId}` → agent_status/result/diff
- `POST /v0/operations/jobs/{jobId}/apply` → agent_apply after product confirmation/approval checks
- `GET /v0/operations/github/... ` → existing bounded GitHub tools

No replacement operational semantics are defined here.

## Collaboration

### GET /v0/groups
### POST /v0/groups
### GET /v0/groups/{id}/messages?cursor=
### POST /v0/groups/{id}/messages
### POST /v0/messages/{id}/reactions
### POST /v0/attachments/initiate
### POST /v0/attachments/{id}/complete

Attachment storage/provider choice is deferred; metadata must bind uploader, workspace, content type, size, digest and scan state.

## Approvals

### GET /v0/approvals
### POST /v0/approvals
### POST /v0/approvals/{id}/decision

Approval execution remains separate from the decision record. A decision does not invoke an operational write unless an explicit product workflow asks the server to do so.

## Security assessment

### POST /v0/security/assessments
Creates an assessment plan request.

### GET /v0/security/assessments/{id}
### POST /v0/security/assessments/{id}/run
### POST /v0/security/assessments/{id}/cancel
### GET /v0/security/assessments/{id}/findings
### POST /v0/security/findings/{id}/retest
### POST /v0/security/assessments/{id}/pipeline-export

All execution is source/target bound and policy checked.

## Recovery

Recovery APIs are intentionally not generalized in V0. Only specific independently proven recovery operations may be added, each with typed preconditions and explicit destructive classification.

## BE1A concurrency read/control contract

Proposed bounded product-facing adapter:

### GET /v0/execution/projects
Per visible project:
- queueDepth
- activeJobs
- runningReaders
- runningWriters
- waitingLeases
- capacity
- state

### GET /v0/execution/leases
Safe lease summaries:
- leaseId
- projectId
- resourceClass
- safe resource identity
- mode
- state
- owner job id
- acquiredAt
- expiresAt/heartbeat state

No secrets, host paths or raw Docker identifiers.

### POST /v0/execution/jobs/{jobId}/cancel
Delegates to job-scoped cancellation and current authority checks.

### GET /v0/execution/global-exclusive
Returns whether a global-exclusive class is held/waiting and safe category metadata.

The frontend never receives a primitive to acquire arbitrary leases directly.
