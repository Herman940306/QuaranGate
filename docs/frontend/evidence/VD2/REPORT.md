# VD2 shell, navigation, and authority candidate

Owner: Herman. Accepted implementation base: commit `a51ff833cce756f758bc27a849a5a37ab6f87250`, tree `5f49230ef2d91bcf6d5a2305688c0801d4d16721`. VD1 had independent PASS_REVIEW per owner direction. This report describes a VD2 candidate for independent read-only review; it does not self-accept VD2 or start VD3.

## Scope and result

Read `docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md`, `DESIGN.md`, `UX-CONTRACT.md`, repository/frontend agent contracts, `frontend/CLAUDE.md`, and the accepted VD1 R2 report before mutation. VD2 groups every existing primary and supporting route in the shared desktop rail and narrow drawer, retains active route treatment, preserves the 248px graphite rail and approximately 68px desktop command bar, and keeps workspace/account/last-read context visible. A shell-wide Authority Strip names Read, Write, Execution, and Destructive as classifications only; eligibility and grants remain server-controlled. The overview trust ribbon names Client, Gateway, and Executor without fabricating live status. An unavailable/forbidden last-read banner refers to the affected panel rather than claiming general service health. Shell copy distinguishes completed from applied. No operational request, permission, confirmation, credential, provider, Docker, GitHub, or backend authority code changed.

The desktop and narrow screenshots were inspected against the accepted VD1 captures and normative design documents. `VISUAL_REVIEW.md` records the comparison ledger and remaining limits. No separate approved Figma frame was identified for pixel comparison. All screenshots are local synthetic/unavailable-state evidence, not live runtime proof.

## Validation and audit

| Gate | Final result | Evidence |
| --- | --- | --- |
| Typecheck | PASS | `typecheck.txt` |
| Lint | PASS, one pre-existing informational suggestion in the unchanged capture harness | `lint.txt` |
| Unit | PASS, 164/164 | `unit.txt` |
| Production build | PASS; restores tracked `next-env.d.ts` | `build.txt` |
| npm audit | PASS, zero vulnerabilities at requested threshold | `npm-audit.txt` |
| Full browser | PASS, 75/75 (VD1 72 plus three VD2 shell cases) | `browser-full.txt` |
| Focused theme/contrast | PASS, 1/1 across light/dark/palette combinations | `browser-theme.txt`, screenshots |
| Strict Premium | Eight carried-forward, independently adjudicated `form.textarea-resize-missing` scanner limitations; zero new findings; scanner exits 1 | `premium.json`, `premium.txt`, `audit-scope-proof.json` |
| Secret scan | PASS, bounded 158-file source/test pattern scan | `secret-scan.json` |
| Accessibility | PASS in tested browser states; axe, keyboard/focus, forced colors, reduced motion, 200% reflow | `browser-full.txt`, screenshots |

The Premium audit ran at the repository root using the tracked manifest with `sourceRoots=["frontend/src"]`. Generated Playwright/Next files were excluded; root contract findings were zero. Its eight finding records match the accepted VD1 output exactly. The shared Textarea primitive and scanner code were not changed, and no resize class was duplicated at consumers. This is the carried-forward adjudicated scanner limitation, not a claim that the Strict Premium command passed.

The first full browser run was diagnostic: 64 passed and 11 failed because the new banner duplicated exact panel error text and shell geometry overflowed at 200% zoom. A focused remediation run then exposed an axe landmark issue and remaining zoom overflow. The banner became a labeled section with distinct copy; container-width rules resolved zoom reflow. Seven focused regressions passed, followed by the final full 75/75 suite. Intermediate failure output was observed but not retained as a raw full log; `browser-focused-remediation.txt` preserves the later failed focused run and `VISUAL_REVIEW.md` records the sequence. Only the final full run is used for qualification.

`contrast-check.json` computes explicit shell text pairs. The Warm Workbench authority support text improved from 4.5857:1 in the first VD2 render to 5.6702:1, while the accepted VD1 palette tokens stayed unchanged. Browser axe checks and representative screenshots cover light, dark Delft, Warm Workbench, forced colors, narrow layout, and 200% reflow. The bounded secret scan is not exhaustive security scanning. Browser plugin was unavailable, so the repository Playwright workflow supplied the rendered checks.

## Preservation and freeze boundary

`prestate.json` verifies the accepted base and historical evidence manifests: VD0 55 files, VD0 recapture 59, prior VD1 58, VD1-R1 4, and VD1-R2 45. All historical bytes must remain unchanged. VD2 evidence is additive under this directory. The development run regenerated `frontend/next-env.d.ts`; the final deterministic production build restored its tracked content, and it is excluded from the candidate. Generated test results, Playwright reports, and `.next` are excluded from staging.

```text
FRONTEND_VISUAL_SOT_READ=YES
FRONTEND_VISUAL_SOT_PATH=docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md
DESIGN_CONFORMANCE_SCOPE=VD2_SHELL_NAVIGATION_AUTHORITY_AND_TRUST_PRESENTATION
IMPLEMENTATION_BASE=a51ff833cce756f758bc27a849a5a37ab6f87250
IMPLEMENTATION_BASE_TREE=5f49230ef2d91bcf6d5a2305688c0801d4d16721
VD2=FROZEN_FOR_INDEPENDENT_REVIEW
VISUAL_CONFORMANCE=NOT_YET_FINAL
INDEPENDENT_VISUAL_REVIEW_REQUIRED=YES
NEXT_EXACT_ACTION=INDEPENDENT_READ_ONLY_REVIEW_OF_VD2_CANDIDATE
```
