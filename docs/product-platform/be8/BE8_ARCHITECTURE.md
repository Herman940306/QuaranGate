# BE8 Architecture — Universal Security Discovery / Planner

## Scope

BE8 adds a non-destructive, read-only security discovery and planning layer. It determines what a governed target appears to be, which security capability categories apply, and which future assessment phases need runtime, build, deployment, network, or credential authority.

BE8 does not execute arbitrary scanners, mutate CI pipelines, install dependencies, run package-manager scripts, perform network requests, accept browser-declared stack truth, or expose shell/Docker execution surfaces.

## Components

- `frontend/src/server/product/security/types.ts` defines stack detection, capability, applicability, and assessment-plan contracts.
- `frontend/src/server/product/security/discovery.ts` performs static metadata detection with provenance.
- `frontend/src/server/product/security/capabilities.ts` defines the server-owned capability registry.
- `frontend/src/server/product/security/planner.ts` maps detected facts into deterministic assessment plans.
- `frontend/src/server/product/security/service.ts` enforces product workspace scope.
- `frontend/src/app/api/product/security/**` exposes bounded discovery and plan endpoints.

## Discovery model

The browser supplies only bounded discovery selectors: `projectId`, optional `targetId`, and optional `assessmentIntent`. It cannot supply source files, file metadata, source revision, detected stack, provenance, or a prior discovery object.

A server-owned `SecuritySourceAdapter` resolves the authenticated Principal/workspace/project/target to the trusted source snapshot. The default production adapter fails closed until the governed registered-project source integration is available. Paths from that trusted snapshot must be workspace-relative, normalized, non-absolute, non-empty, and non-escaping. Symlinks, binary files, oversized manifests, malformed manifests, and malicious paths are reported as unsupported facts rather than silently trusted.

Every detected technology carries source type, path, confidence, and detector version. Caller-declared stack values are rejected rather than treated as truth.

## Planner model

The planner is deterministic. It creates no execution authority and emits capability states such as `APPLICABLE`, `REQUIRES_RUNTIME`, `REQUIRES_BUILD`, `REQUIRES_DEPLOYMENT`, `REQUIRES_CREDENTIAL`, `REQUIRES_NETWORK`, `NOT_APPLICABLE`, and `UNKNOWN`. Unknown facts remain unknown.

## Future handoff

BE9-BE12 may consume BE8 plans to perform governed scanner execution or pipeline synthesis. BE8 only creates the planning contract.
