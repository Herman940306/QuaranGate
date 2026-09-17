# QuaranGate Incident Response Runbook

This runbook governs suspected credential exposure, unauthorized authority use, audit/evidence integrity failure, unexpected network exposure, source/runtime drift, provider compromise, failed resource cleanup, or uncertain mutation/recovery state. It is intentionally conservative: preserving evidence and stopping unsafe authority takes precedence over service continuity.

## 1. Declare and scope the incident

Record a local incident identifier, UTC timestamp, reporter, affected service/principal/project/provider, and the first known symptom. Do not paste raw credentials, prompts, repository contents or unredacted provider diagnostics into the incident record.

Classify the affected authority planes independently:

- public gateway/authentication;
- gateway↔executor internal control plane;
- executor↔Docker-authority broker;
- GitHub App/broker;
- provider backend credential/egress;
- IDE session control;
- live writer/apply authority;
- lifecycle/deployment/backup state;
- host/container runtime.

## 2. Contain without destroying evidence

Use the narrowest safe action that stops additional authority. Examples include disabling/revoking one principal, disabling an optional provider, stopping the affected QuaranGate service through the bounded lifecycle path, or isolating approved ingress. Do not run broad Docker cleanup, delete volumes, wipe logs, rotate every credential blindly, reset Git worktrees, or delete quarantine/evidence state before evidence is preserved.

If a live mutation is `UNCERTAIN`, preserve quarantine and the real workspace state. Do not mark it successful or manually edit the durable database to clear the condition.

## 3. Preserve evidence

Capture, without exposing secrets:

- exact repository branch/HEAD/status/staging and accepted receipt identity;
- deployed image references and immutable image IDs;
- relevant gateway audit stream records plus `streamId`, sequence range and chain head;
- process/container restart boundaries that explain audit-stream changes;
- durable job/apply/quarantine/IDE evidence relevant to the incident;
- bounded runtime health/readiness and source/image/runtime parity;
- hashes of preserved evidence artifacts.

Enterprise deployments must also preserve the corresponding external append-only audit/SIEM records. A local in-memory Control Center view is not sufficient incident retention.

## 4. Revoke and rotate affected credentials

Rotate only after evidence required to understand exposure has been preserved, unless immediate revocation is necessary to stop active abuse.

- client key exposure: revoke that client key and prove the old key is denied;
- `INTERNAL_TOKEN` exposure: coordinated gateway/executor rotation and readiness requalification;
- `DOCKER_AUTHORITY_TOKEN` exposure: coordinated executor/broker rotation, prove old token denial, and preserve distinctness from `INTERNAL_TOKEN`;
- Kiro/Copilot credential exposure: replace the owner-controlled credential file, revoke provider-side old credential where supported, and run a fresh bounded provider qualification only when entitlement is available;
- GitHub App private key exposure: rotate/revoke at GitHub, replace the local key and requalify installation-token/repository bounds;
- IDE credential exposure: revoke the enrollment/session generation so stale credentials/replays are denied.

Never place the replacement credential value into the incident record.

## 5. Investigate exact authority and integrity

Determine whether the event was:

- denied by policy with no authority gained;
- an allowed action by a compromised authorized principal;
- an authority-policy defect;
- secret disclosure without proven use;
- runtime/source/image drift;
- provider or external-service failure;
- resource-cleanup ambiguity;
- audit/evidence integrity or retention failure;
- host/runtime compromise outside QuaranGate's trust boundary.

Recompute audit-chain hashes for the preserved stream and investigate sequence/hash gaps. A valid hash chain does not prove the gateway itself was uncompromised; correlate with the external collector and runtime evidence.

## 6. Remediate in an isolated writer lane

For a product defect:

1. freeze the exact vulnerable source/runtime evidence;
2. reproduce with a deterministic regression where safe;
3. implement the narrow fix in one isolated writer lane;
4. run focused and widened regression suites;
5. run the required repository security/release gates for the affected surface;
6. freeze immutable commit hashes and evidence;
7. perform the applicable independent review, or owner-authorized strict self-audit when that governance exception is explicitly active;
8. promote only by the accepted integration procedure.

Do not weaken an existing test, allowlist, isolation rule, cleanup check or release policy to make remediation pass.

## 7. Recover service

Recover from the exact accepted source/image and a verified recovery anchor/backup when needed. Re-prove:

- source/image/runtime identity;
- health and authenticated readiness;
- credential rotation/revocation state;
- authority invariants;
- orphan/resource reconciliation;
- audit collection and chain anchoring;
- affected provider/IDE/GitHub/target behavior;
- restore integrity where a backup was used.

Do not opportunistically pull/build/update during recovery.

## 8. External findings

For an external penetration-test finding, use `docs/security/pentest/FINDING_TEMPLATE.md` and `docs/security/pentest/RETEST_PROTOCOL.md`. A finding is not externally closed until the independent retest requirements are met against the exact remediated target. Internal tests or self-audit may support remediation evidence but must not be represented as the external retest.

## 9. Exit criteria

Close the incident only when:

- unsafe authority is contained;
- affected credentials are revoked/rotated with old-value denial proven where technically possible;
- evidence is preserved and integrity checked;
- root cause and affected boundary are documented without unsupported speculation;
- product-controlled defects have immutable accepted remediation;
- runtime recovery/requalification for the affected boundary has passed, or an honest external blocker is recorded;
- required external retest remains explicitly open if it has not occurred;
- lessons that change operating assumptions/runbooks/tests have been incorporated.

If any requirement cannot be proven, retain the incident as open/blocked rather than converting uncertainty into PASS.
