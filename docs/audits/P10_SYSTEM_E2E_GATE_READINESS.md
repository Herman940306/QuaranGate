# P10 Full-System Adversarial E2E Release Gate Readiness

## Status

`IMPLEMENTED / SOURCE-ONLY / LIVE SYSTEM E2E NOT RUN`

The P10 full-system lifecycle qualification is a distinct required release gate named `system-e2e`. It does **not** claim that the live Windows/WSL/provider/IDE lifecycle has been executed or accepted. The existing SH-05 `e2e` gate remains the synthetic rendered-browser gate and is not a substitute.

## Review history and authority correction

The first immutable source candidate, `8dc47baa3d5f70db978d04e4f954f477837707b6`, correctly introduced the nineteenth release gate but failed strict review on evidence authority. Its schema v1 accepted self-asserted `signedPackageVerified`, evidence-safety/manual-review booleans and arbitrary hash-correct per-step files. A forged 15-step run containing no live operation proof returned validator exit `0 / PASS`. That candidate is preserved as FAIL-review evidence and must not be integrated unchanged.

Schema v2 removes those self-attested authority fields. A `system-e2e` PASS now requires all of the following independent inputs and bindings:

- exact clean source-binding receipt;
- exact P9 release manifest;
- detached P9 Ed25519 release-signature proof;
- installer-owned release trust policy supplied separately from release material;
- exact signed Windows package file whose bytes are SHA-256 hashed by the validator;
- finalized external system-E2E evidence manifest;
- a separate independent review receipt bound to the exact finalized manifest/package/source/release identity.

The validator reuses the same canonical release-signature payload semantics as P9. It verifies the selected trusted key is Ed25519, verifies the detached signature cryptographically, records the trusted key id/fingerprint, and refuses a signature created after the qualification run has begun.

## Required P10 chain

`system-e2e` accepts only this exact ordered 15-step chain:

1. `fresh-install`
2. `configure`
3. `enroll`
4. `kiro`
5. `ollama`
6. `copilot`
7. `github`
8. `ide`
9. `jobs`
10. `restart-crash`
11. `resume`
12. `review`
13. `apply`
14. `evidence`
15. `backup-recovery`

Every step must be `PASS`, have strictly ordered UTC start/completion timestamps, and bind at least one exact evidence artifact. The evidence root is closed: only `manifest.json`, `artifacts/`, and `review/independent-review.json` are permitted, every artifact must be referenced exactly once, and unmanifested/symlinked/traversal/tampered evidence is rejected.

## Environment and reviewer boundary

The run must attest `DISPOSABLE_QUALIFICATION`, `WINDOWS11_WSL2`, `productionData:false`, and `customerData:false`. The manifest is finalized as `EVIDENCE_COMPLETE_REVIEW_PENDING` before independent review.

The separate review receipt must be `PASS / ACCEPT`, assert reviewer independence, name a bounded reviewer identity distinct from the qualification operator, bind the exact source commit, P9 manifest digest, signed-package SHA-256 and finalized evidence-manifest SHA-256, contain zero findings, and record `secretScan:PASS`, zero credential markers and zero customer identifiers. Its review timestamp must be later than the final qualification step.

This is a process trust boundary, not a claim that local files are magically tamper-proof against a malicious host administrator. The dedicated release runner and reviewer identities remain trusted release-operating roles. The validator ensures those roles cannot be replaced by booleans inside the run manifest and that the exact reviewed bytes are the bytes accepted by release assurance.

## Release-policy integration

`security/release-policy.json` requires nineteen gates. `system-e2e` is pinned to:

- tool: `quarangate-system-e2e-validator` version `2`;
- command identity: `p10-system-e2e-validate`.

Release assurance consumes only path-valued inputs:

- `QG_SYSTEM_E2E_EVIDENCE_DIR` / `--system-e2e-evidence-dir`;
- `QG_RELEASE_MANIFEST` / `--release-manifest`;
- `QG_RELEASE_SIGNATURE_PROOF` / `--release-signature-proof`;
- `QG_RELEASE_TRUST_POLICY` / `--release-trust-policy`;
- `QG_SIGNED_WINDOWS_PACKAGE` / `--signed-package`.

Missing inputs produce `SYSTEM_E2E_PREREQUISITES_UNAVAILABLE` with bounded missing-prerequisite codes and therefore `BLOCKED_ENVIRONMENT`, never PASS. Supplied-but-invalid, stale, unsafe, tampered or non-PASS evidence produces a genuine gate FAIL.

The release security policy and final evidence bundle independently validate the bounded v2 summary: exact source/product/release-manifest identity, signed-package SHA-256, trusted signing key id/fingerprint, finalized evidence-manifest digest, independent reviewer identity/time, exact 15-step count, artifact bounds and disposable Windows 11/WSL2 classification.

## Current live truth

No `system-e2e` PASS is claimed by this source implementation. Until genuine signed release material, installer trust, a disposable Windows 11/WSL2 run and independent review exist for the exact release candidate, P10 remains blocked rather than shortening or fabricating the chain.
