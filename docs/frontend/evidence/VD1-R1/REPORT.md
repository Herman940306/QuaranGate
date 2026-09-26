# VD1 R1 inspection and scope stop

The owner prompt section 11 requires stopping when Strict Premium exposes a materially separate issue outside VD1. This condition was established before changing implementation. No CSS, component, test, audit rule, manifest, generated output, historical evidence, stage or commit was changed. Only this new evidence directory and the frontend README registry were written.

```text
FRONTEND_VISUAL_SOT_READ=YES
FRONTEND_VISUAL_SOT_PATH=docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md
DESIGN_CONFORMANCE_SCOPE=R1 preflight; badge token trace; all 51 Strict Premium findings classified; no implementation change
PRESTATE_HEAD=fdc2c6d843b341e6010bf5c88e20f5cf2516dfd9
PRESTATE_TREE=714437c33d501947669a65265d9c1ef93b9b5a30
PRESTATE_STATUS=DIRTY_UNSTAGED
LANE_FREE=YES_NO_FRONTEND_SERVER_OR_COMPETING_SOURCE_CHANGE_DETECTED
PORT_3100_FREE=YES
ATTENTION_BADGE_FAILURE_CONFIRMED=YES_FROM_PRESERVED_BROWSER_RECEIPT_AND_MATCHING_SOURCE
OLD_CONTRAST_RATIO=4.45:1
OLD_FOREGROUND=#98582d
OLD_BACKGROUND=#ebe5dc
TOKEN_OR_COMPONENT_OWNER=globals.css shared --attention-text over Warm Workbench --surface-muted
SOURCE_CHANGE=NONE_STOP_CONDITION_BEFORE_REMEDIATION
NEW_FOREGROUND=NOT_MEASURED
NEW_BACKGROUND=NOT_MEASURED
NEW_CONTRAST_RATIO=NOT_MEASURED
STRICT_PREMIUM_ROOT_CAUSE=SEPARATE_ROOT_RESOLUTION_GENERATED_HTML_HISTORICAL_FORM_AND_SHARED_COMPONENT_FINDINGS
STRICT_PREMIUM=FAIL_PRESERVED_51_FINDINGS_NOT_RERUN
FOCUSED_CONTRAST_TEST=NOT_RUN_STOP_CONDITION
BROWSER_FULL=NOT_RUN_R1_PRIOR_71_PASS_1_FAIL_PRESERVED
TYPECHECK=NOT_RUN_R1
LINT=NOT_RUN_R1
UNIT=NOT_RUN_R1
BUILD=NOT_RUN_R1
NPM_AUDIT=NOT_RUN_R1
DIFF_CHECK=PASS_EXIT_0
HISTORICAL_EVIDENCE_UNCHANGED=YES_HASH_VERIFIED
VD0_EVIDENCE_UNCHANGED=YES_ORIGINAL_AND_RECAPTURE_HASH_VERIFIED
NEXT_ENV_DRIFT_CLASSIFICATION=PREEXISTING_GENERATED_DEV_TYPE_IMPORTS_PRESERVED_UNSTAGED
VD1_R1_COMMIT=NONE_REQUIRED_GATES_NOT_GREEN
VD1_R1_TREE=NOT_CREATED
VD1_R1_PARENT=NOT_CREATED
VD1_R1_SUBJECT=NOT_CREATED
WORKTREE_CLEAN=NO_PRESERVED_DIRTY_LANE
VISUAL_CONFORMANCE=NOT_YET_FINAL
INDEPENDENT_VISUAL_REVIEW_REQUIRED=YES
OPEN_BLOCKERS=contrast remains failing; historical Agent Arena form omission; strict audit root/source resolution; Figma reference unidentified
NEXT_EXACT_ACTION=owner decides separate historical form/audit remediation scope before resuming R1
```

The exact failed browser assertion is the axe violations check at foundation.spec.ts:169, in the theme test beginning at line 148. Preserved failure output reports foreground #98582d and background #ebe5dc at 4.45:1. Current globals.css matches the source hash from the failed run. This is an evidence-confirmed failure, not a new browser measurement. The color derives from shared --attention-text (90% normative attention mixed with 10% ink); the Warm Workbench theme changes the badge's muted background. The narrowest prospective ownership is a light Warm Workbench attention-text theme derivation, without changing the normative warning hue or other surfaces. No proposed mix or ratio is claimed validated.

The entire 51-finding audit was read. 38 findings target generated Playwright trace HTML. Four contract/evidence findings arise from invoking the audit at frontend while its tracked manifest contains repository-root-relative paths. Root DESIGN.md, UX-CONTRACT.md (including Canonical UI Map), and the configured failure-path test exist. No new contracts should be invented to satisfy the incorrect root. Nine source findings concern four files that mechanically match HEAD: one real Agent Arena form missing noValidate, and eight static textarea findings at calls to the shared Textarea. Shared Textarea applies class resize-none and globals.css defines resize: none. Those eight scanner findings are not automatically eight runtime defects. There is no badge-contrast finding in this Strict Premium output. No finding in those source files was introduced by the dirty VD1 changes.

The missing noValidate is historical and independently conflicts with the maintained product form contract. Changing that operational form or broadening the audit remediation is outside this narrow owner authorization, which expressly requires stopping for separate historical issues. All findings and their exact classifications are registered in findings-classification.json. This report does not waive the contrast threshold or the Premium gate.

The complete test/build/audit sequence and conditional commit were not run because the inspection stop condition fired first. Prior validation results are not promoted to R1 PASS. Historical and VD0 original/recapture bytes are hashed in prestate.json and rechecked after this documentation update. Source hashes include the unchanged generated next-env.d.ts drift.
