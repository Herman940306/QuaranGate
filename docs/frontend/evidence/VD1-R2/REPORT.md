# VD1 R2 final freeze evidence

Owner: Herman. Scope: VD1 token and shared primitive convergence, bounded Agent Arena form repair, and R2 evidence finalization. This is a candidate for independent read-only review, not visual acceptance or VD2.

## Provenance and Strict Premium classification

Prestate HEAD is `fdc2c6d843b341e6010bf5c88e20f5cf2516dfd9`. The original 51-finding scan was invoked from `frontend` and included 38 generated Playwright trace HTML findings. Four root-resolution findings arose because the tracked manifest's contract and test paths are relative to the repository root. Correct invocation at the repository root, with `frontend/premium-ui.json`, scanned `sourceRoots=["frontend/src"]`, zero generated files, and produced zero root-contract findings. It reduced the count to nine before product repair. The source-only scope and unmodified third-party scanner are recorded in `audit-scope-proof.json`; the nine-finding output is `premium-root-corrected.json`.

The historical Agent Arena form omitted `noValidate`. R2 added it without changing submit/requestSubmit behavior. The focused form regression passed 3/3. The corrected audit then reported eight findings, all `form.textarea-resize-missing` at `Textarea` imports from `./primitives` in Agent Arena, Approvals, GitHub Experience, and Operational Workstation. `textarea-ownership-proof.json` identifies every call site. The shared owner in `frontend/src/components/primitives.tsx` emits `className="resize-none"`; `frontend/src/app/globals.css` defines `.resize-none { resize: none; }`; `UX-CONTRACT.md` defines `Textarea | resize none + auto-grow`. The focused browser assertion confirms computed `resize: none` for Agent Arena. The scanner only checks call-site attributes and has no supported shared Textarea ownership resolution. No third-party audit code or eight consumer call sites were changed to satisfy it.

```text
AUDIT_ROOT_CORRECTED=YES
GENERATED_FILES_SCANNED=0
ROOT_CONTRACT_FINDINGS=0
STRICT_PREMIUM=BLOCKED_SCANNER_STATIC_RESOLUTION
STRICT_PREMIUM_FINDINGS=8
STRICT_PREMIUM_PRODUCT_DEFECTS_REMAINING=0_PROVEN
STRICT_PREMIUM_SCANNER_LIMITATIONS=8
TEXTAREA_PRODUCT_RUNTIME_DEFECT=NOT_PROVEN
TEXTAREA_STATIC_SCANNER_LIMITATION=PROVEN
```

This classification requires independent reviewer adjudication. It is not Strict Premium PASS. `premium-after.json` is the authoritative final audit output; `premium-after.txt` records its command/result. The untracked `frontend/premium-audit.json` was a generated duplicate of the preserved historical `docs/frontend/evidence/VD0-RECAPTURE-20260926/premium-audit.json`, both SHA-256 `4198f65f25af5056e56011eb0b665a9c285fbe33b2bb0e7f2772c0ad00981a81`; only the untracked duplicate was removed. The final eight-finding R2 audit is separately preserved here and hashed in `SHA256SUMS`.

## R2 result and validation

Warm Workbench attention foreground changed from `#98582d` to `#91552d` over `#ebe5dc`, raising measured contrast from 4.45:1 to 4.7367:1 at 1280px and 360px. `attention-theme-matrix.json` contains computed values; `focused-contrast.txt` and `contrast-measurement-receipt.txt` record the focused browser result. Other palette behavior, forced colors, and 200% reflow coverage remained green.

| Check | Result | Receipt |
| --- | --- | --- |
| Focused Agent Arena form | PASS, 3/3 | `focused-form.txt` |
| Focused contrast | PASS, 1/1; 4.7367:1 | `focused-contrast.txt`, `attention-theme-matrix.json` |
| Full browser | PASS, 72/72 | `browser-full.txt` |
| Typecheck | PASS | `typecheck.txt` |
| Lint | PASS | `lint.txt` |
| Unit | PASS, 164/164 | `unit.txt` |
| Production build | PASS | `build.txt` |
| npm audit | PASS, zero vulnerabilities | `npm-audit.txt` |
| Secret scan | PASS, bounded high-signal source/test scan | `secret-scan.json` |
| Diff whitespace | Product source, tests, harness, report, and checksums PASS; default staged whole-candidate check flags preserved raw tool-log whitespace | Final Git diff checks at freeze |

The full browser/build results precede this report and checksum finalization. No product source or test file was changed afterward. The bounded source/test secret scan does not claim exhaustive secret detection.

At freeze, `git diff --check` passed and the scoped `git diff --cached --check` for product source, tests, harness, report, and checksums passed. The default whole-candidate `git diff --cached --check` reported whitespace in raw VD0/VD1/R2 build, lint, test, and captured diff logs. Those bytes are protected by evidence hashes, so they were preserved. A whole-candidate check with only `blank-at-eol` and `blank-at-eof` disabled passed. This is an evidence-format limitation, not a clean default staged diff-check result.

## Evidence preservation and generated lifecycle

R2 is additive. `prestate.json` registered 212 protected historical evidence hashes; all 212 were recomputed from current bytes and matched. Phase manifests were also recomputed and matched: VD0 55/55, VD0 recapture 59/59, VD1 prior receipts 58/58, VD1-R1 4/4. No historical evidence file was overwritten. The invalidated historical VD1 capture remains invalidated; preservation does not rehabilitate its render provenance.

`next-env.prestate.txt` preserves the generated development-type import drift. The deterministic production build restored the tracked `frontend/next-env.d.ts` content, recorded in `next-env.after-build.txt`. It is absent from the final source diff and commit. `frontend/tests/visual-recapture.mjs` was inspected in full and syntax checked. It uses an exclusive bounded port 3100 probe, exact spawned child listener PID/cwd checks, its own Playwright browser, and awaited SIGTERM cleanup with a ten-second stop bound. The earlier owned-server capture and conflict regression proof remain in VD0 recapture evidence. Its use depends on an already-built isolated source snapshot and the local Linux `ss`/`/proc` facilities; the capture proves synthetic unavailable MCP render provenance, not live backend integration.

```text
HISTORICAL_EVIDENCE_UNCHANGED=YES
VD0_EVIDENCE_UNCHANGED=YES
VD1_R1_EVIDENCE_UNCHANGED=YES
NEXT_ENV_PRESTATE_DRIFT=PRESERVED_IN_R2_EVIDENCE
NEXT_ENV_FINAL_TRACKED_STATE=RESTORED_BY_DETERMINISTIC_BUILD
NEXT_ENV_INCLUDED_IN_COMMIT=NO
VD1=FROZEN_FOR_INDEPENDENT_REVIEW
VISUAL_CONFORMANCE=VD1_CANDIDATE_READY_FOR_INDEPENDENT_REVIEW
INDEPENDENT_VISUAL_REVIEW_REQUIRED=YES
OPEN_BLOCKERS=STRICT_PREMIUM_SHARED_TEXTAREA_STATIC_RESOLUTION_REVIEW
NEXT_EXACT_ACTION=INDEPENDENT_READ_ONLY_REVIEW_OF_VD1_CANDIDATE
```
