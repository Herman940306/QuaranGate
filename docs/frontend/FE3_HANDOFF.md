# FE3 — Provider configuration and Agent Profiles

Lane: `/home/herman/projects/QuaranGate-product-fe3-gpt`, branch `feature/qg-product-fe3-provider-agents-gpt`. Accepted FE2 base: `e470d8303efeb70d243785f5b934cec1fa0d277a`. Agent A owns this frontend source candidate. No push, merge, deployment, server/API/package/config/runtime/canonical mutation or live BE4 connection is authorized.

## Review and qualification status

FE3-R1-01: **ACCEPTED / PASS_REVIEW** by the orchestrator. Root cause: the client deleted `secretValue` from the adapter's request before its asynchronous Promise settled. Correction: the caller intent is scrubbed as the call begins, while a separate request-scoped copy stays valid until adapter settlement. The client does not retain that request afterward. Safe `ProviderView` projection still discards echoed fields. Immutable JavaScript strings cannot be cryptographically zeroized; no memory zeroization is claimed. The external reviewer's token-refresh failure was superseded by this orchestrator review.

The FE3 candidate is frontend-only and uses an injected semantic adapter. Production `/providers` and `/agent-profiles` stay `integration_pending` with disabled reads. Development-only `/product-preview` supplies synthetic fixtures and returns 404 in production. Saved configuration and validation are distinct from ACP admission, Principal grants, dispatch authority and runtime preconditions. No live provider secret custody or BE4 transport is claimed.

## FE3 checkpoints

CHECKPOINT: FE3.2 — Provider inventory/detail
STATUS: QUALIFIED_SOURCE_CANDIDATE
IMPLEMENTED: Bounded provider list/inspect, explicit pending/loading/available/empty/unavailable/forbidden/stale/conflict states, context echo and safe metadata projection.
TESTS: Desktop/narrow browser inventory, empty/forbidden/unavailable states, axe, responsive screenshots and production pending route PASS.
OPEN INTEGRATION GAPS: No accepted BE4 inventory adapter or safe server label contract.

CHECKPOINT: FE3.3 — Provider editor and write-only secret
STATUS: QUALIFIED_SOURCE_CANDIDATE
IMPLEMENTED: Returned kind/scope choices; missing choices keep editor open with associated error and focus. Uncontrolled password has no prefill/readback and clears on submit, invalid submit, cancel and unmount. Caller intent is scrubbed; the adapter receives a stable request-scoped copy through settlement.
TESTS: Synchronous and asynchronous adapter tests, response projection, rejection/cancellation units, browser setup/edit, invalid choice focus, asynchronous pending/cancel, lifecycle and persistence assertions PASS.
OPEN INTEGRATION GAPS: Server custody, CSRF/session binding, mutation acknowledgement and write-only transport remain unaccepted.

CHECKPOINT: FE3.4 — Provider validation
STATUS: QUALIFIED_SOURCE_CANDIDATE
IMPLEMENTED: Version-aware request and server-returned unknown/pending/succeeded/failed display. Validation never implies admission or dispatch.
TESTS: Browser success/failure/stale cases and unit unchanged-version rejection PASS.
OPEN INTEGRATION GAPS: Live server validation lifecycle/status contract absent.

CHECKPOINT: FE3.5 — Agent Profile semantic client
STATUS: QUALIFIED_SOURCE_CANDIDATE
IMPLEMENTED: Typed list/inspect/save seam; bounded returned references/optionsVersion and safe profile projection. Delete remains disabled.
TESTS: Unit unreturned-reference rejection and browser create/edit/workspace isolation PASS.
OPEN INTEGRATION GAPS: Accepted profile transport, server option freshness and atomic version/reference checks absent.

CHECKPOINT: FE3.6 — Agent Profile inventory/detail
STATUS: QUALIFIED_SOURCE_CANDIDATE
IMPLEMENTED: Separate profile inventory/detail and link to accepted operational `agents_list` read surface.
TESTS: Desktop browser inventory/detail screenshot, axe and workspace separation PASS.
OPEN INTEGRATION GAPS: Live profile inventory absent; no visibility or authority inferred.

CHECKPOINT: FE3.7 — Agent Profile editor
STATUS: QUALIFIED_SOURCE_CANDIDATE
IMPLEMENTED: Bounded name and returned reference/capability choices, version-aware submit, focus on invalid name, cancel. No host/runtime/path field.
TESTS: Invalid name/focus, create, edit and keyboard/browser qualification PASS.
OPEN INTEGRATION GAPS: Server-side option and version enforcement required at BE4 integration.

CHECKPOINT: FE3.8 — Dispatch authority boundary
STATUS: QUALIFIED_SOURCE_CANDIDATE
IMPLEMENTED: UI describes future profile selection → server preflight → existing `agent_dispatch` authority → current resource/runtime preconditions. FE1 read client remains unchanged.
TESTS: Source boundary scan and browser authority copy PASS. No dispatch mutation is introduced.
OPEN INTEGRATION GAPS: Product dispatch workflow remains unaccepted and unimplemented.

CHECKPOINT: FE3.9 — Identity/context isolation
STATUS: QUALIFIED_SOURCE_CANDIDATE
IMPLEMENTED: FE2 identity epoch remounts product projections/editors; pending requests abort and late results are suppressed. Duplicate writes and timeout/cancel outcomes require explicit reread.
TESTS: Unit request arbitration and browser workspace/identity switch, cancellation/late response, focus recovery PASS.
OPEN INTEGRATION GAPS: Actual account/workspace transport and reauthorization absent.

CHECKPOINT: FE3.10 — Final frontend qualification
STATUS: QUALIFIED_SOURCE_CANDIDATE_PENDING_FREEZE
IMPLEMENTED: Development synthetic preview, registered FE3 files, bounded evidence and FE3-aware production smoke.
TESTS: `fe3-evidence/validation.json` records typecheck, lint, 123/123 units, production build, 35/35 Chromium E2E, FE3-aware production smoke, npm audit (zero vulnerabilities), strict premium audit and `git diff --check`. Earlier full E2E attempts found test hydration races in legacy Git/Jobs input tests; their failures and the targeted fix are retained in the validation receipt. FE3 screenshot evidence is synthetic and visually reviewed against `DESIGN.md` and FE1/FE2 tokens. Axe zero violations on tested FE3 states, reduced motion, forced colors and CSS `zoom: 2` at 360/1280 are covered. A local FE3 authority-strip forced-colors override corrected white-on-white emphasis found in the narrow zoom screenshot; the corrected screenshot and computed foreground/background distinction were checked. `security.json` and `SHA256SUMS` bind bounded source/evidence scans.
OPEN INTEGRATION GAPS: No BE4 adapter, live custody, live provider validation, production backend qualification or full manual assistive-technology certification. Candidate freeze and orchestrator final acceptance remain separate.

## Security and visual limits

Static source review and browser tests found no FE3 secret persistence in localStorage, sessionStorage, IndexedDB, cookies, URL, logs or evidence; no secret readback, raw provider error, operational grant synthesis, arbitrary host/runtime/path field or FE3 proxy. Error copy is fixed and server responses pass through allowlist projections. Browser assertions prove the synthetic secret is absent from rendered text, URL and tested storage after submit, cancel and unmount. Static scans are defense in depth, not proof against every possible future adapter. Tests use synthetic values only and do not exercise BE4.

Screenshots capture provider desktop/narrow, profile desktop and forced-colors narrow/zoom states. The established mineral/graphite/blue QuaranGate visual system, authority strip, IBM Plex typography and bounded controls remain in use; no new palette, glass, neon or generic SaaS visual layer was added. The Browser plugin was unavailable; repository Playwright Chromium performed rendered qualification. `zoom: 2` simulates CSS layout zoom, not browser chrome or pinch zoom.

## Freeze protocol

Commit exactly once from the accepted base after every final gate passes. Stage only FE3-owned source, tests, documentation and bounded evidence. Create post-commit `fe3-evidence/FREEZE.json` as the sole intentional untracked receipt; bind candidate HEAD/tree/parent/subject, changed paths, committed hashes and gate exits. Stop for orchestrator final FE3 acceptance review. No push, merge or deployment.
