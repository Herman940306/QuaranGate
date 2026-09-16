# SH-06 Immutable Image / Base Governance

## Status

`CLOSED / SOURCE_ACCEPTED / OWNER_AUTHORIZED_STRICT_SELF_AUDIT`

Base canonical: `51c94b25ce69de7eb2dbd48802444645cf8fe888` on
`integrate/quarangate-forward`.

This document records source design and current qualification only. It is not a
source-acceptance receipt, independent review, live owner-host deployment proof,
provider certification, rollback execution, or production-release approval.

## 1. External Dockerfile base identities

SH-06 removes tag-only external `FROM` inputs from all seven tracked
Dockerfiles. External registry bases are bound to reviewed SHA-256 digests;
Docker stage aliases remain valid internal `FROM` targets.

Candidate source pins:

- `node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81`
- `node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`
- `node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`
- `alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc`

These exact digest identities were selected from the official Docker image
metadata observed during SH-06 work on 2026-09-16. Source records the digest;
it never treats the mutable tag alone as identity.

The npm dependency-preparation helper and N1 acceptance path use the exact same
`node:24-alpine` digest and retain `--pull=never` / offline source-build
semantics.

## 2. Static source enforcement

`security:invariants` now fails closed if:

- any external Dockerfile `FROM` is not `@sha256:<64 lowercase hex>`;
- a primary production service loses its mandatory image-selection expression;
- a governed production service loses `pull_policy: never`.

The rule set is now 15 rules over 10 Compose files and 7 Dockerfiles. A negative
unit fixture proves that a newly introduced tag-only Dockerfile base is rejected
with `IMMUTABLE_DOCKERFILE_BASE`.

## 3. Primary QuaranGate runtime images

`compose.yaml` no longer carries a `quarangate:latest` production fallback.
Gateway, Docker-authority and executor require three explicit service-specific
references and each service has `pull_policy: never`:

- `GATEWAY_IMAGE`
- `DOCKER_AUTHORITY_IMAGE`
- `EXECUTOR_IMAGE`

Candidate deployment builds one reviewed QuaranGate artifact and assigns three
role-specific commit tags. The tags are selectors, not cryptographic identity.
The immutable Docker content ID is captured independently.

## 4. Persisted tag-to-image-ID binding

Successful owner deployment atomically persists and directly verifies six
runtime keys:

- `GATEWAY_IMAGE` / `GATEWAY_IMAGE_ID`
- `DOCKER_AUTHORITY_IMAGE` / `DOCKER_AUTHORITY_IMAGE_ID`
- `EXECUTOR_IMAGE` / `EXECUTOR_IMAGE_ID`

Every persisted image ID must be `sha256:<64 lowercase hex>`. Before deployment
commit, every role tag must still resolve to the captured ID. Rollback is
similarly verified by both prior `Config.Image` and prior immutable `.Image` ID.

Unattended recovery trusts neither ambient shell variables nor tags by
themselves: it loads the six persisted keys, proves each tag still resolves to
its persisted image ID before Compose start, uses `--no-build --pull never`, and
then verifies each live primary container by both role tag and immutable image
ID. Optional GitHub broker/proxy services are bound to the same gateway artifact
ID.

For one migration only, candidate deployment may derive a missing historical
`DOCKER_AUTHORITY_IMAGE` selector from exactly one already-running
Compose-labelled Docker-authority container. This exception exists only in the
controlled deployment/migration path. Unattended recovery has no corresponding
fallback and requires the persisted SH-06 identity set.

## 5. Provider/helper runtime image binding

The executor already resolved Copilot and GitHub helper references through the
bounded Docker-authority `image.inspect` operation before use. SH-06 applies the
same immutable binding to Kiro and Ollama:

- configured Kiro runner/helper/proxy references are validated, inspected once
  at startup, and converted to immutable Docker image IDs;
- configured Ollama helper/stager references are validated, inspected once at
  startup, and converted to immutable Docker image IDs;
- a non-SHA Docker inspect identity fails executor startup closed before
  provider availability or `listen()`;
- resolved IDs, not mutable tags, are passed to later sandbox/container
  creation.

No new Docker operation, socket mount, privilege, network, capability, host
path, provider authority, or public control surface is introduced. This uses the
existing governed `image.inspect` authority.

The external Ollama service image is separately required to be a
`repository@sha256:<digest>` reference with `pull_policy: never` for unattended
production recovery.

## 6. Preserved startup ordering

Durable AgentJobStore construction/migration remains the first ACP startup step.
Image resolution happens after durable-store construction and before any
provider sandbox/factory can become available. The accepted recovery/lifecycle
ordering remains unchanged. Execution tests prove an invalid image ID prevents
orphan reconciliation and prevents `listen()`.

## 7. Current validation

Current mutable-candidate validation before freeze:

- dedicated/widened affected matrix: `14/14 files`, `585/585 tests` PASS;
- full repository unit suite: `131/131 files`, `2902/2902 tests` PASS;
- TypeScript typecheck: PASS;
- build: PASS;
- `security:invariants`: PASS, `15/15` rules over 10 Compose files and 7 Dockerfiles;
- modified shell-script syntax: PASS;
- `git diff --check`: PASS;
- exclusive `/tmp/q`: absent after focused and full-unit runs;
- cgroup `oom_kill`: unchanged at 17 across the widened qualification.

These results must be rerun on the frozen immutable candidate before source
acceptance.

## 8. Explicit non-claims / remaining live qualification

SH-06 source work does **not** claim:

- any exact pinned base image is presently provisioned on the owner host;
- a Docker image build has been executed on the owner host for this candidate;
- the owner runtime `.env` has already been migrated to all six image identity keys;
- an existing owner Ollama selection has already been converted from a version tag to an exact digest;
- candidate deployment, rollback, restart or live container identity has executed;
- provider inference, cancellation or live egress has been requalified;
- bit-for-bit cross-platform build reproducibility beyond exact base selection;
- P10/A9 or P11 release qualification.

Those are later owner-host / final-candidate qualification gates. Source must
not weaken immutable-image policy merely because those live artifacts are not
available in this governed source target.
