# QUARANGATE — P10-V VISUAL PRODUCT DEMO & DOCUMENTATION EVIDENCE READINESS

## Status

**Source preparation:** `IMPLEMENTED / SOURCE-ONLY / NOT P10-V ACCEPTANCE`

**Execution:** `BLOCKED_BY_P10` until the exact source-matching P10/A9 production qualification summary is `PASS` and a qualified local real-runtime/browser environment exists.

This package prepares the accepted P10-V evidence contract. It does not claim that screenshots, demo clips, accessibility evidence, or rendered-browser release acceptance exist today.

## Authority boundary

P10-V visual authority must come from the **real QuaranGate Console runtime** for the exact accepted release candidate. The existing `e2e/playwright.config.ts` + `e2e/mock-server.mjs` remain the SH-05 synthetic rendered-browser release gate and are not visual product authority.

The P10-V config is therefore separate:

`e2e/p10v.playwright.config.ts`

It has no Playwright `webServer` and no mock-server reference. The target is supplied explicitly through `QG_P10V_BASE_URL` and is restricted by default to the exact `/console/` root on `127.0.0.1`, `localhost`, or loopback IPv6. Automatic non-local recording is refused; a future non-local/disposable capture requires a distinct owner-authorized gate rather than a permissive flag hidden in this source package.

## Sequencing lock

`e2e/scripts/p10v-readiness.mjs` requires all of:

1. exact clean current Git source identity;
2. an existing P10 release-assurance `summary.json`;
3. P10 summary status `PASS`;
4. exact P10 source commit/tree equality with the current source;
5. an external empty owner-only evidence directory;
6. pinned Playwright dependencies;
7. a launchable Chromium runtime;
8. the real local Console endpoint responding successfully.

If P10 is `BLOCKED_ENVIRONMENT`, failed, stale, or bound to another source revision, P10-V exits blocked **before creating the evidence directory**. This prevents visual evidence from being captured against an unaccepted candidate and later mistaken for release authority.

## Frozen visual contract

The source contract is `e2e/contracts/p10v-visual-evidence.mjs`.

It binds visual documentation to the same independent authoritative 21-route Console map used by the rendered-browser gate:

`overview`, `chat`, `projects`, `targets`, `files`, `terminal`, `git`, `processes`, `agents`, `jobs`, `review`, `ide-sessions`, `github`, `models`, `monitoring`, `statistics`, `security`, `audit`, `recovery`, `settings`, `tool-lab`.

The required short deterministic demo set is:

1. `install-first-run`
2. `console-tour`
3. `governed-task`
4. `ide-session`
5. `github-workflow`
6. `failure-recovery`
7. `backup-recovery`

These are separate bounded clips, not one long marketing recording. A polished overview may be derived only after the required qualification evidence is accepted.

## Real-runtime Playwright route evidence

`e2e/p10v-tests/route-evidence.spec.ts` is intentionally excluded from the synthetic SH-05 config and runs only through `p10v.playwright.config.ts`.

It requires an explicitly provisioned disposable qualification credential through `QG_P10V_BROWSER_CREDENTIAL` **and** the explicit attestation `QG_P10V_CREDENTIAL_CLASS=SYNTHETIC_DISPOSABLE`; the value is used only to connect and is never written to the evidence summaries. The class assertion prevents an operator from silently treating a real/customer credential as acceptable test input. The route evidence run:

- connects to the real Console;
- walks the exact 21-route map;
- asserts the expected route title and visible main content;
- runs WCAG A/AA Axe checks on every route;
- fails on any serious/critical violation;
- writes one canonical full-page PNG per route;
- records bounded page/console error summaries;
- records only request method/path/status in the safe network summary — never headers, bodies, query strings, cookies or credentials;
- keeps Playwright trace/video only on failed qualification by default.

The required guided workflow clips remain a later real-runtime qualification activity because their exact system state must come from the accepted P10 environment, not from mocked or fabricated source fixtures.

## Evidence directory

Evidence is external to the Git worktree and owner-only. The prepared layout is:

```text
<external-p10v-evidence>/
  contract.json
  readiness.json
  identity/
    source.json
    runtime.json
    browser.json
  screenshots/
    routes/<21 route ids>.png
  demos/
    <7 required workflow ids>.webm
  playwright/
    results.json
    test-results/...
  visual/
    summary.json
  accessibility/
    report.json
  observability/
    console-summary.json
    network-summary.json
  security/
    public-media-scan.json
  review/
    independent-review.json   # created only after finalization
```

`identity/runtime.json` must bind both `sourceCommit` and `runtimeRevision` to the exact accepted source commit and must attest `environment: DISPOSABLE_QUALIFICATION`, `productionData: false`, and `customerData: false`. It cannot be inferred from screenshot appearance or localhost addressing.

## Public-media safety gate

Before finalization, `security/public-media-scan.json` must be `PASS` and must state all of:

- `manualReview: true`
- `secrets: 0`
- `pii: 0`
- `privatePaths: 0`

Manual review is mandatory because binary image/video encoding cannot be treated as proof that visible secrets, personal data, or private workstation paths are absent. The automated scan and manual review are complementary requirements.

## Finalization

`e2e/scripts/p10v-evidence-finalize.mjs` refuses finalization unless:

- all 21 canonical route screenshots exist and are non-empty;
- all seven demo clips exist and are non-empty;
- source/runtime/browser identity receipts are PASS;
- runtime/source identities match the exact expected source commit;
- the pinned Playwright JSON reporter has at least one expected pass and zero unexpected, skipped, flaky, or top-level error outcomes;
- the visual receipt is PASS, is bound to the exact source commit, covers all 21 routes, and reports zero mismatches (or the separately reviewed first-release canonical-baseline procedure when no prior accepted baseline exists);
- serious/critical accessibility counts are zero;
- console summary is PASS with zero errors;
- safe network summary is PASS and marked secret-free;
- public-media manual/security review passes;
- no evidence artifact is a symlink or non-regular file;
- evidence file-count and byte bounds are respected.

Only then does it create `manifest.json` plus sorted `SHA256SUMS`, hashing every input evidence artifact. Existing final outputs are never overwritten. This boundary is deliberately **not** P10-V acceptance: the manifest status is `EVIDENCE_COMPLETE_REVIEW_PENDING`.

After finalization, an independent reviewer produces `review/independent-review.json` containing the exact source commit and finalized manifest SHA-256. `e2e/scripts/p10v-acceptance.mjs` accepts only a PASS/ACCEPT receipt that asserts reviewer independence, has no open findings, and binds to the exact manifest. It then re-hashes every manifested artifact and verifies `SHA256SUMS` and the post-finalization file set so media cannot be changed after review. Only that second gate may return `ACCEPTED`.

## No-shortcut rules

P10-V acceptance must not be manufactured by:

- using `e2e/mock-server.mjs` as product authority;
- capturing from stale `main` or a different source/runtime revision;
- snapshot auto-update;
- weakening visual/accessibility tolerances to make a failure disappear;
- masking broken authority-bearing regions;
- skipping required routes/workflows;
- using real customer data;
- recording production/non-local targets without a separate owner authorization;
- publishing/uploading evidence before the public-media review gate passes;
- treating source-author self-review as the required independent P10-V acceptance review;
- modifying screenshots, videos, reports, `SHA256SUMS`, or any other manifested evidence after finalization/review.

Any negative result remains a blocker until fixed, rerun, and rebound to the exact accepted candidate.

## Source qualification required before integration

This readiness package is source-only. Acceptance of the source package requires unit/static tests, root typecheck/build/diff-check, security invariants, fixed-seed fuzz, and an immutable replay. Actual P10-V remains blocked until P10 is PASS and the qualified browser/runtime is available. Even after evidence capture/finalization, final acceptance remains pending until a genuinely independent reviewer issues a manifest-bound PASS receipt.
