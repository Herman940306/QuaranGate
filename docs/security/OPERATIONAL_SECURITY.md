# Operational Security Baseline

This is the enterprise operating-security contract for QuaranGate. It is intentionally separate from point-in-time source acceptance: a source commit can satisfy this document while deployment, external pentesting, provider entitlement, IDE availability, release scanning or owner-host recovery remain honestly blocked.

## 1. Secure defaults

Production/runtime surfaces must preserve all of the following unless a separately reviewed security change explicitly replaces them:

- gateway published only on loopback by default;
- executor and Docker-authority broker unpublished;
- raw `/var/run/docker.sock` mounted only into `docker-authority`;
- executor reaches Docker only through the named authenticated broker contract;
- `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true` and bounded PID/memory controls on the primary trusted services where defined by their role;
- internal service network remains private/internal;
- callers select logical targets/projects/jobs, never arbitrary Docker ids, host binds, images, networks, devices, capabilities or daemon paths;
- production image selection remains immutable/fail-closed and `pull_policy: never` remains enforced by the release invariant gate;
- optional provider/IDE surfaces remain disabled unless their trusted configuration is present and valid.

A convenience failure is never justification to publish the executor/broker, grant a work target the Docker socket, enable a network fallback, or weaken an authority check.

## 2. Operational secrets

### Client credentials

Client API keys are per-principal. Only hashes belong in `config/clients.yaml`; raw keys are shown once by the generator and must not be committed or copied into tickets/chat/logs.

### Internal service credentials

`INTERNAL_TOKEN` authenticates gateway-to-executor requests. `DOCKER_AUTHORITY_TOKEN` authenticates executor-to-Docker-authority requests. They must be independently generated, must differ, and must be stored only in the ignored runtime secret/configuration surface. Production Compose requires `DOCKER_AUTHORITY_TOKEN`; the executor broker client refuses equality with `INTERNAL_TOKEN`.

### Provider credentials

Kiro and Copilot credentials are host files/secret mounts, not ordinary command arguments or repository configuration. Credential reads must reject symlinks, non-regular files, unsafe permissions, unsafe replacement and malformed framing. Job-scoped secret volumes must be removed deterministically; a failed deletion is an operational failure, not success.

GitHub App private-key material must remain outside source and follow its provider-side key rotation/revocation process. Installation tokens are bounded provider artifacts and must not be treated as durable operator credentials.

### Secret handling rules

Never publish raw values in audit/evidence, shell history, `docker compose config` output, support bundles, issue trackers or release artifacts. Release/evidence bundling must continue to reject secret/credential paths.

## 3. Rotation and revocation

Rotation is complete only when both the old credential is unusable and the replacement path has been requalified.

- **Client API key:** generate a new per-client key, update the hashed client record through the governed configuration process, prove the new key, revoke/delete the old client key hash, then prove the old credential is denied.
- **INTERNAL_TOKEN:** generate a fresh value, update the trusted runtime secret source, restart the gateway/executor together through the bounded lifecycle path, prove authenticated readiness, then destroy the prior value.
- **DOCKER_AUTHORITY_TOKEN:** generate a distinct fresh value, update executor and broker atomically through the bounded lifecycle path, restart/requalify both, prove the old token cannot call the broker, and verify it is still distinct from `INTERNAL_TOKEN`.
- **Kiro/Copilot:** replace the owner-controlled file atomically with the required restrictive mode, requalify a fresh job, then revoke/retire the provider-side old credential where the provider supports that action.
- **GitHub App:** rotate the private key at the provider, update the owner secret file, requalify installation-token minting and granted-repository bounds, then revoke the superseded key.
- **IDE session credentials:** use the existing generation/revocation contract; stale generation/replay must remain denied.

If coordinated rotation cannot be completed safely, stop the affected capability rather than running indefinitely with ambiguous mixed credentials.

## 4. Audit integrity and retention

Gateway audit stdout uses `SHA256_CHAIN_V1`. Each emitted record contains a stream id, sequence number, prior-record hash and current entry hash. This detects mutation/reordering/deletion within an exact captured stream only if the stream or head is independently retained.

This mechanism is **not** a digital signature, durable store or defense against a fully compromised gateway rewriting future output. Process restart begins a new stream. Enterprise operation therefore requires:

1. forward stdout audit records to an access-controlled append-only/immutable collector;
2. retain process start/restart metadata so stream boundaries are explainable;
3. periodically anchor the current chain head outside the gateway trust domain;
4. alert on sequence gaps, previous-hash mismatch, unexpected stream reset, parser failure and retention failure;
5. restrict collector deletion and retention-policy mutation to separate administrative authority;
6. preserve relevant audit records during incidents/legal holds before normal retention removes them.

The Control Center activity view is only a bounded in-memory operational window (2048 entries / 24 hours) and is never the enterprise system of record.

Durable job/apply/quarantine evidence and IDE event evidence are separate evidence planes. Do not infer durability of one plane from another.

## 5. Backup and restore boundaries

Backups are security artifacts. Preserve ownership, mode, digest and exact source identity; do not turn a backup into an uncontrolled secret archive.

- QuaranGate lifecycle recovery anchors use private roots, validate path ownership, reject dangerous overlap/recursion, and verify payload digest/mode before and after restore.
- Durable agent job/evidence state must be backed up only from a stable/quiesced state and restored only with an integrity check.
- Gateway OAuth/session data is separable from durable job evidence and may be recreated at the cost of reauthorization where policy permits.
- Provider credentials are preserved by reference or explicit reauthorization by default; raw credential inclusion is not an implicit backup behavior.
- A custom policy that explicitly includes credentials becomes a high-sensitivity backup and must be encrypted/access-controlled under the operator's enterprise secret-management policy.
- Backup roots must not recurse into themselves or overlap lifecycle roots in ways the path-ownership policy forbids.
- Restore tests must use a disposable environment first. A backup that has never passed restore verification is not release/recovery evidence.

## 6. Recovery and service lifecycle

Startup reconciliation and cleanup are security boundaries.

- resource deletion is successful only when the underlying Docker/bounded lifecycle operation confirms it;
- tracked secret/workspace/network/container handles are not cleared when cleanup cannot be proven;
- startup orphan reconciliation must fail closed on inventory/removal failures instead of claiming orphan cleanup succeeded;
- provider/session state must never be silently resurrected across an ambiguous lifecycle event;
- `UNCERTAIN` mutation/quarantine state requires explicit investigation and recovery, never direct database editing to force success;
- recovery must remain exact-source/exact-image bound and must not pull/build/update opportunistically.

Use the bounded deployment/lifecycle procedures; do not replace them with generic `docker system prune`, broad volume deletion or ad-hoc database edits.

## 7. Incident handling

Follow `docs/operations/INCIDENT_RESPONSE.md`. Minimum principles are: stop unsafe authority first, preserve evidence before cleanup, revoke/rotate affected credentials, identify exact accepted source/runtime identity, recover through bounded lifecycle mechanisms, and requalify the affected boundary before restoring service.

An external finding is closed only by the remediation/retest semantics in the SH-14 pentest package. Internal remediation or self-audit must never be relabeled as an external pentest PASS.

## 8. Least privilege

- Grant principals only required scopes, targets, projects, backends and profiles.
- Keep `targets:read`, `targets:logs`, `targets:control`, file mutation, terminal execution, agent dispatch/apply and GitHub write/review authority separate.
- Keep provider credentials backend-specific.
- Keep Docker-authority broker credential separate from the gateway/executor token.
- Keep agent runners free of raw Docker, arbitrary host binds and unrelated provider credentials.
- Keep work targets free of QuaranGate infrastructure authority.
- Preserve one live writer per governed project/worktree and the existing writer/apply arbitration.

## 9. Deployment and runbook truth

Before any deployment or recovery:

1. prove repository/worktree branch, HEAD, tree status and staging state;
2. bind to the exact accepted source/audit receipt;
3. verify immutable image identities and required local artifacts;
4. verify runtime secret prerequisites without printing their values;
5. render/validate Compose only through sanitized or local evidence paths;
6. deploy through the bounded owner/lifecycle path;
7. prove health **and** readiness plus source/image/runtime parity;
8. retain rollback/recovery evidence;
9. record anything unavailable as unavailable, not PASS.

Current forward source is not automatically the currently deployed runtime. Historical deployed receipts remain historical until the exact forward candidate is deployed and requalified.

## 10. Known limitations and external gates

The following limitations must remain explicit until their own accepted gates change them:

- SH-14 genuine independent external pentest execution/retest is external and is not self-certified.
- SH-03 MCP SDK/protocol migration remains dependent on the exact approved external artifact/provenance path; unavailable artifacts are not downloaded ad hoc to manufacture closure.
- SH-04 first enterprise IdP selection is an owner decision gate; no IdP is invented by source code.
- Copilot and Kiro live provider acceptance remains dependent on genuine owner entitlement/test capability where recorded by project control.
- VS Code final live re-verification and Cursor live qualification remain environment/runtime gates; source acceptance is not live acceptance.
- owner-host lifecycle recovery remains an owner-host/live gate where project control records it as such.
- full release assurance remains blocked when required integration/browser/scanner/image/provenance inputs are unavailable; intrinsic source gates do not substitute for them.
- POSIX owner/mode protections separate Unix identities but cannot isolate malicious processes already running under the same UID.
- audit hash chaining detects captured-stream tampering but is not authenticity or durable retention by itself.
- a compromised executor holding valid named-operation credentials still has meaningful authority within the broker's permitted product operations; the broker boundary prevents raw/generic Docker authority, not all impact.

## 11. Enterprise operating assumptions

An enterprise deployment assumes a trusted host/runtime baseline, controlled local administrator access, high-entropy secret generation/storage, protected time/log collection, an approved ingress/TLS identity, immutable/reviewed artifacts, tested backup/restore, and operators who do not broaden QuaranGate authority to bypass a failed gate.

Where central secret management, SIEM/immutable log retention, EDR, backup encryption, IdP, vulnerability management or change-management systems are required by the organization, QuaranGate integrates operationally with those controls; their existence must not be inferred from QuaranGate source alone.

## 12. Release evidence requirements

A production release must bind evidence to the exact candidate. At minimum, retain the release policy/receipt outputs for all required intrinsic and environmental gates, including typecheck/build/unit, authority invariants, deterministic security fuzz/chaos where required, SBOM, integration/E2E, required offline SAST/secret/SCA/config/image scanning, source/image binding and provenance/signing inputs.

A required tool/input being unavailable produces `BLOCKED_ENVIRONMENT`/the applicable blocked state, never an invented PASS. SH-14 external pentest evidence is separate and must name the exact tested revision/artifact. If security-relevant source changes after a pentest target was bound, rebind/retest according to the pentest protocol before using the old report as release evidence.
