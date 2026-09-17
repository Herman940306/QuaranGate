# P10 Full-System E2E Qualification Runbook

Use this runbook only for the exact P10 release candidate in a disposable Windows 11 + WSL2 qualification environment. Never use production/customer data.

## 1. Freeze release identity first

Before the live run, independently record and verify:

- exact clean Git source commit/tree;
- exact P9 release manifest/digest;
- detached P9 Ed25519 release-signature proof;
- installer-owned release trust policy supplied independently from the release bundle;
- exact signed Windows package file and SHA-256;
- immutable release-image identities;
- isolated qualification machine/VM identity.

If source, manifest, signature/trust identity or package bytes change, discard the run for release acceptance and start again.

## 2. Evidence directory

Create a new owner-private directory outside the QuaranGate worktree (`0700` on Unix/WSL). Required final layout is exact:

```text
<run>/
  manifest.json
  artifacts/
    ... every reviewed step artifact, all referenced by manifest.json ...
  review/
    independent-review.json
```

No other top-level or review files are accepted. Do not place secrets, bearer credentials, customer identifiers or production data into artifacts.

## 3. Finalized run manifest — schema v2

`manifest.json` is finalized before review and must use `status: EVIDENCE_COMPLETE_REVIEW_PENDING`. Conceptual shape:

```json
{
  "schemaVersion": 2,
  "status": "EVIDENCE_COMPLETE_REVIEW_PENDING",
  "runId": "p10-system-e2e-<bounded-id>",
  "operatorId": "<bounded qualification operator id>",
  "source": {
    "repository": "<exact repository or null>",
    "branch": "<exact branch or null>",
    "commit": "<40-hex commit>",
    "tree": "<40-hex tree>",
    "clean": true
  },
  "environment": {
    "classification": "DISPOSABLE_QUALIFICATION",
    "platform": "WINDOWS11_WSL2",
    "productionData": false,
    "customerData": false
  },
  "release": {
    "productVersion": "<exact semver>",
    "manifestDigest": "<exact P9 manifest digest>",
    "signedPackageSha256": "<SHA-256 of supplied package bytes>"
  },
  "steps": [
    {
      "id": "fresh-install",
      "status": "PASS",
      "startedAt": "<UTC ISO timestamp>",
      "completedAt": "<later UTC ISO timestamp>",
      "artifacts": [
        {
          "path": "artifacts/<safe-relative-file>",
          "sha256": "<64-hex SHA-256>",
          "bytes": 123,
          "kind": "JSON"
        }
      ]
    }
  ]
}
```

The `steps` array contains all fifteen required IDs in the exact documented order. Artifact kinds are limited to `JSON`, `LOG`, `SCREENSHOT`, `VIDEO`, `ARCHIVE`, or `RECEIPT`.

## 4. Evidence expected per step

Evidence must prove the transition, not only that a command was issued:

- `fresh-install`: trusted release-package verification, installed source/runtime identity and health;
- `configure`: accepted configuration/authority choices without secret values;
- `enroll`: project/target enrollment and governed authority identity;
- `kiro`: genuine entitled provider-backed Kiro operation/session;
- `ollama`: genuine local Ollama operation/model;
- `copilot`: genuine entitled Copilot provider-backed operation;
- `github`: governed selected-repository operations within approved authority;
- `ide`: supported primary IDE companion/session evidence;
- `jobs`: durable governed job lifecycle;
- `restart-crash`: controlled restart/crash plus durable pre/post state;
- `resume`: accepted source-bound session/job resume;
- `review`: governed review result and authority evidence;
- `apply`: reviewed mutation application with stale-base/integrity protections;
- `evidence`: canonical evidence publication/integrity receipt;
- `backup-recovery`: backup plus verified recovery/restoration.

Required providers/capabilities are not skippable. If they are unavailable, P10 remains blocked.

## 5. Independent review receipt

After all artifact bytes and `manifest.json` are final, a different reviewer performs semantic/evidence-safety review and writes only `review/independent-review.json`:

```json
{
  "schemaVersion": 1,
  "status": "PASS",
  "verdict": "ACCEPT",
  "reviewerIndependent": true,
  "reviewerId": "<different bounded reviewer id>",
  "reviewedAt": "<UTC later than final step>",
  "operatorId": "<exact manifest operatorId>",
  "sourceCommit": "<exact source commit>",
  "releaseManifestDigest": "<exact P9 manifest digest>",
  "evidenceManifestSha256": "<SHA-256 of exact manifest.json bytes>",
  "signedPackageSha256": "<exact package SHA-256>",
  "evidenceSafety": {
    "secretScan": "PASS",
    "credentialMarkers": 0,
    "customerIdentifiers": 0
  },
  "findings": []
}
```

The reviewer must reject insufficient evidence even when the step says `PASS`. The reviewer must not be the qualification operator. Any finding keeps P10 unaccepted.

## 6. Validate

Run from the exact clean release source tree:

```text
node scripts/p10-system-e2e-evidence.mjs \
  --evidence-dir <external-run-directory> \
  --source-binding <exact-source-binding.json> \
  --release-manifest <exact-p9-release-manifest.json> \
  --release-signature-proof <exact-release-signature-proof.json> \
  --release-trust-policy <installer-owned-release-trust-policy.json> \
  --signed-package <QuaranGate-Setup.exe>
```

The validator verifies the P9 signature cryptographically against installer-owned trust, hashes the supplied package itself, re-hashes all manifested evidence, rejects unmanifested bytes, validates the independent review binding and returns only a bounded v2 PASS summary.

## 7. Release runner

The dedicated no-download release runner uses path-only variables:

- `QG_SYSTEM_E2E_EVIDENCE_DIR`;
- `QG_RELEASE_MANIFEST`;
- `QG_RELEASE_SIGNATURE_PROOF`;
- `QG_RELEASE_TRUST_POLICY`;
- `QG_SIGNED_WINDOWS_PACKAGE`.

Do not copy evidence or trust material into Git source. Do not alter evidence after review. Missing inputs remain `BLOCKED_ENVIRONMENT`; invalid supplied material is a real FAIL.
