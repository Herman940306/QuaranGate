# FE2 identity frontend — A-007

Status: FE2 frontend source candidate ready for immutable freeze and orchestrator review. All dependency-ready FE2 sections complete; unreviewed, not accepted, live-integrated or deployed. Candidate commit/tree/hashes are bound by lane-local `fe2-evidence/FREEZE.json` after commit.

## Authority / identity

Owner-authorized sole writer Agent A. Lane `/home/herman/projects/QuaranGate-product-fe2-gpt`; branch `feature/qg-product-fe2-identity-ui-gpt`. Accepted FE1 base `896f9f0554a8569447772aed6488f40755058338`; tree `d424cdf42fc0c0b314d2ed7580b2c47d5f46540f`. Read-only preflight: HEAD/tree/branch MATCH; index and worktree CLEAN. Owner prompt designates this lane; no second writer observed. Initial shell cwd was F1; all mutations explicitly target FE2. No root Vitest or shared `/tmp/q` use.

## Boundaries / canonical reuse

Keycloak human identity ∩ product membership/roles ∩ mapped QuaranGate Principal ∩ live resource/runtime preconditions. Server owns final authority. Entra federation through Keycloak cannot mint operational grants. No email field: approval for server-returned email is not frozen. No token, raw claim, cookie, provider payload, credential input, persistence or URL auth material is part of the public contract.

Existing `DESIGN.md`, `UX-CONTRACT.md`, product authority/API V0 docs and FE1 read UX inspected. Canonical owners retained: native Select/Field/Button/Panel/Table, global CSS tokens/scrollbar/focus, OverlayProvider navigation drawer, AppearanceProvider/MotionConfig. English engineering workstation; no locale or geography change. Identity feedback uses shared primitives and safe inline status. Native workspace select accepts OS popup geometry for a bounded membership list (maximum 100). No shared design/config/package/server/API/backend changes authorized or made.

CHECKPOINT: FE2.1
STATUS: COMPLETE
IMPLEMENTED: Browser-safe projected session, semantic injected adapter/client, memory-only store, cancellation, 15s timeout, response ordering, explicit lifecycle/error states, opaque version guard and immediate operational-projection invalidation epoch. Extra token/claim/email fields discarded; malformed context fails closed. No default network identity calls.
TESTS: Gap reproduced (missing identity module); focused identity units 34/34 PASS; initial frontend typecheck PASS. Includes ignored abort, late replies, duplicate writes, stale membership/version, expiry, unmapped principal and raw-provider errors.
OPEN INTEGRATION GAPS: Accepted BE1 transport/CSRF/cookie/navigation adapter absent; backend identity remains unavailable.
NEXT: Sign-in surface.

CHECKPOINT: FE2.2
STATUS: COMPLETE
IMPLEMENTED: `/sign-in`, semantic redirect-intent button, disabled default pending integration, Keycloak/federation explanation; no credentials collected or server handlers. Shared state feedback/provider.
TESTS: Identity UI 17/17 PASS; frontend typecheck PASS. Credential inputs absent and pending-integration sign-in disabled in rendered markup.
OPEN INTEGRATION GAPS: Accepted redirect adapter absent; redirect cannot fabricate authentication.
NEXT: Safe account view.

CHECKPOINT: FE2.3
STATUS: COMPLETE
IMPLEMENTED: `/account` safe identity/context, opaque session version, UTC issue/expiry, safe federation label, principal mapping state/reference; refresh/logout/cancel and unavailable recovery. Roles preview links; operational authority statement. No raw claims/tokens/email.
TESTS: Identity UI 18/18 PASS; safe references, expiry, principal and HTML escaping exercised.
OPEN INTEGRATION GAPS: Session/logout transport absent. Synthetic account qualification follows; no production logged-in fixture.
NEXT: Workspace selector.

CHECKPOINT: FE2.4
STATUS: COMPLETE
IMPLEMENTED: `/workspaces` bounded server-membership native selector; exact opaque expected version; no inferred workspace options; synchronous invalidation before switch, pending/cancel/reconcile, stale/forbidden/conflict recovery. No optimistic switch or retries.
TESTS: Identity units 34/34 PASS; frontend typecheck PASS. Covers exact switch parameters, context clearing, denied options, stale versions, duplicate writes, timeout/cancellation, late response and wrong/unchanged workspace replies.
OPEN INTEGRATION GAPS: Server must atomically re-resolve membership/principal and reject stale expected version; adapter missing.
NEXT: Product authorization explanation.

CHECKPOINT: FE2.5
STATUS: COMPLETE
IMPLEMENTED: `/permissions` and account summary use shared ProductAuthorization; explicit roles/overrides workflow eligibility, server-returned display-only capability summary, separate principal mapping. No browser authority computation, privilege score or permission editing.
TESTS: Identity UI 19/19 PASS; administrator role with forbidden principal remains denied, summaries escape markup and preserve authority explanation.
OPEN INTEGRATION GAPS: Server must supply safe summary labels; display summary never authorizes operations.
NEXT: Lifecycle handling qualification.

CHECKPOINT: FE2.6
STATUS: COMPLETE
IMPLEMENTED: Shared explicit signed-out/active/expiring/expired/revoked/unavailable/stale/conflict UI; mapped/unmapped/unavailable/forbidden principal feedback. Local expiry tick clears account and invalidates projections; focus/visibility revalidate. Cancellation/timeout retain no account context and require server reconciliation.
TESTS: Combined identity contracts/UI 53/53 PASS; all lifecycle copy, expiry transition and principal states covered. Browser transitions follow in FE2.9.
OPEN INTEGRATION GAPS: Revocation is known only from server revalidation; no push/SSE subscription invented. Local expiry can restrict display, never grants authority.
NEXT: Shell integration.

CHECKPOINT: FE2.7
STATUS: COMPLETE
IMPLEMENTED: Identity/account/workspace shell links and safe status, unknown/unavailable navigation stays usable. Identity epoch remounts FE1 read subtree, clearing receipts/input/result projections and aborting late reads. Appearance/overlay providers remain canonical outside identity reset. Existing nine FE1 routes/source read clients retained.
TESTS: Full frontend units 108/108 PASS; typecheck PASS. Browser cancellation/invalidation and FE1 regression qualification follow.
OPEN INTEGRATION GAPS: FE1 `/mcp` identity-to-principal binding remains a separate accepted integration gate; shell status never implies operational connection or grants.
NEXT: Cross-device preference seam.

CHECKPOINT: FE2.8
STATUS: COMPLETE
IMPLEMENTED: Client-only PreferenceSyncClient read/write seam binds expected session and preference versions. Unconnected implementation returns integration_pending/cancelled only. Account appearance preview retains F1 page-memory semantics and explicitly labels cross-device sync pending. No backend/persistence integration.
TESTS: Preference boundary 1/1 PASS; memory adapter resets in a new instance, pending sync read/write never reports success.
OPEN INTEGRATION GAPS: Preference data/retention/API authority awaits future owner approval; no sync adapter is installed.
NEXT: Deterministic fixture-only browser/accessibility/security qualification.

## Final shell refinement

FE2.7 implementation narrowed after browser inspection: identity controls stay mounted to preserve focus. `OperationalProvider` tags connection state with the identity epoch; `useOperationalRead` synchronously hides prior receipts/correlation/state and aborts pending controllers when epochs change. Known FE1 operational `<main>` subtrees remount to clear resource/job inputs. Appearance remains outside this boundary. Workspace switch focuses cancellation while pending, then the current selector or session-check recovery control. Logout focuses session-check recovery.

Initial browser qualification found and fixed a hydration race: descendants must hydrate against a stable initial server snapshot even if the provider effect has already started a session refresh. Regression unit added. The initial storage assertion also rejected Next's existing development-only debug DB; the test now follows the established F1 exception for `__next_*` names only. Production smoke still requires zero browser databases. A native select needs Alt+ArrowDown/open, ArrowDown, Enter, Tab for popup keyboard coverage. Appearance interactions wait for hydrated session state and reflected mode/palette before navigation. These failures are disclosed; no gate failure is relabeled as success.

## FE2.10 integration contract

No BE1 live adapter is installed. Current client calls no identity endpoints and never reads cookies, URL auth fields or storage. The proposed V0 documentation is not treated as an accepted BE1 runtime route contract.

### Semantic seam

`IdentityAdapter` returns unknown data for runtime projection; `createIdentityClient(adapter)` produces the typed client. Methods:

- `getCurrentSession(signal)` — return an explicit signed-out/lifecycle/error state or safe active session.
- `beginLogin(signal)` — invoke the accepted provider-navigation intent in the adapter. Return `redirecting` or a safe failure. No URL, state, nonce, PKCE verifier or authenticated session is returned by this method.
- `switchWorkspace(workspaceId, expectedSessionVersion, signal)` — atomically compare the opaque version, re-resolve current membership and principal mapping, return the requested workspace with a new version or a typed denial/conflict. Browser does not merge or retry writes.
- `logout(signal)` — request actual server logout. Only an acknowledged `signed_out` result renders signed out. Failure/cancel leaves context unknown or unavailable and requires reconciliation.

`IdentityClient.integrated` indicates only that an adapter exists; it grants no identity or operational authority. Optional clock injection is for deterministic synthetic qualification only; production uses Date.now. The store has a 15s display timeout; cancellation is not proof that a mutation/redirect was rolled back server-side. Re-check session after unknown outcomes. No automatic mutation retry.

### Safe session shape

`SessionView`: user `{id, displayName}`; organization/workspace `{id, name}`; explicitly authorized `workspaces[]`; safe `roles[]`, `overrides[]`, server-returned display-only `capabilitySummary[]`; principal `{status: mapped|unmapped|unavailable|forbidden, reference?}`; opaque `version`; UTC `issuedAt`/`expiresAt`; optional safe `federationLabel`. Email is deliberately absent pending approval of the returned server contract.

Strings are nonempty, at most 256 characters, without ASCII control characters. Lists are at most 100 entries. Workspace IDs must be unique; current workspace must match a returned member entry. Mapped principal requires a reference; nonmapped references are omitted. Invalid/future issue/invalid expiry metadata fails closed. Extra fields are discarded at every projection, including nested user/principal fields. Time-based expiry removes the account context rather than retaining a stale session. This is display restriction only.

Do not return access/refresh/ID tokens, raw claims, PKCE verifier, state/nonce, cookies, secrets or operational credential material. The adapter must normalize safe labels from an accepted server contract rather than passing raw provider payloads as display names or summaries.

### Required BE1 behavior / adapter work still missing

1. Freeze and accept the exact route, request/response envelope and typed subcodes before wiring. No route names are invented here.
2. Keep provider protocol and credential material server-owned. The browser must receive only safe session views and use server-managed session cookies; session cookies must not be readable by product JavaScript. Final cookie names/attributes, expiry, secure transport and sign-out invalidation require the accepted BE1 contract.
3. Use BE1's accepted same-origin CSRF/origin protections for login intent, workspace mutation and logout; document the exact required headers/handshake in the integration adapter. No CSRF implementation, cookie parsing, auth header or session-token persistence is duplicated in FE2.
4. Bind product human identity, org/workspace membership and QuaranGate Principal explicitly on the server. Re-authorize every operational request, including FE1 `/mcp`; do not derive grants from Entra/Keycloak claims.
5. Return only current authorized membership options. If inventory exceeds the frontend bound, define an accepted bounded membership-selection contract rather than silently clipping or inferring options.
6. Compare expected session version atomically, reject stale/concurrent mutation and return a new version after switching. A mismatched returned workspace, unchanged version or changed user fails the UI closed.
7. Revalidation must reveal expiry/revocation/membership/mapping changes without exposing inaccessible resource/provider details. Focus/visibility checks and local expiry exist; live push revocation is not implemented.
8. Redirect destinations and callback material must be handled by the accepted adapter/server. Product pages never construct provider URLs or store/reflect auth protocol data. Full navigation after accepted login/logout needs fresh browser qualification.

### Error mapping required in the future adapter

| Accepted semantic server outcome | UI state | Recovery |
|---|---|---|
| Unauthenticated | signed_out | Provider sign-in when integrated |
| Product membership forbidden | forbidden | Check account/membership with administrator |
| Stale expected session version | stale | Check session, then explicitly choose again |
| Workspace concurrency/precondition conflict | workspace_conflict | Check session; no assumed mutation |
| Explicit expired or revoked session | expired / revoked | Clear context and sign in again |
| Identity/transport failure, malformed reply or raw provider exception | unavailable | Safe retry via Check session; no details echoed |
| Principal mapping missing/unavailable/denied | unmapped / unavailable / forbidden principal | Product identity does not grant operations |
| Aborted request | cancelled | Check session; server mutation may have completed |
| Login navigation intent acknowledged | redirecting | No authenticated context assumed |

Exact BE1 error-code/subcode mapping remains unaccepted; this table defines semantic UI expectations, not implemented server protocol.

### Required live requalification

Repeat unit adapter/envelope/error projection tests; production login redirect/callback (including malicious URL/state/nonce handling); logout and server revocation; cookie attributes and CSRF rejection; wrong-origin requests; membership denial; two-tab stale-version conflict; same-user workspace change and account change; principal unmapped/unavailable/forbidden; stale operational receipts/inputs/pending reads; expiry/revalidation; narrow/desktop keyboard/focus/axe and all appearance modes/reduced motion. Verify no auth data in storage, URLs, UI, logs or browser-readable cookies. Requalify FE1 same-origin routing and principal/resource authorization separately. No current synthetic result proves accepted BE1 behavior, live federation, production deployment or exhaustive WCAG conformance.

CHECKPOINT: FE2.9
STATUS: COMPLETE
IMPLEMENTED: Development-only injected synthetic preview, fixed clock, active/signed-out/lifecycle/principal/conflict surfaces, version-aware selector, keyboard/focus recovery, identity-driven operational receipt invalidation, local appearance/reduced motion and responsive checks. Production fixture route is 404.
TESTS: Mandatory frontend typecheck/lint/build PASS; 110 units / 6 files PASS; 26 Chromium browser tests PASS (10 FE2 + 16 FE1/F1); production smoke PASS; npm audit zero vulnerabilities; strict premium UI audit zero findings; bounded secret/source-boundary scan PASS; git diff --check PASS. Axe zero violations on tested screens. 1280px/360px signed-out/active/selector/stale screens, all appearance modes, explicit principal/lifecycle states, mutation cancellation/reconciliation and late operational output covered.
OPEN INTEGRATION GAPS: No live BE1/federation/provider/CSRF/cookie qualification; Chromium only, no exhaustive WCAG certification. Development tooling may own only __next_* debug databases; production requires and proves zero databases/storage/cookies. Root Vitest not run.
NEXT: Final integration handoff and candidate freeze.

CHECKPOINT: FE2.10
STATUS: COMPLETE
IMPLEMENTED: Exact semantic adapter/session/error mapping expectations, server-required atomic version/membership/principal behavior, cookie/CSRF boundaries and post-BE1 requalification matrix documented above. Frontend README registers every created source/test/docs/evidence file. No unaccepted route wired; no shared or Agent B surface edited.
TESTS: Mandatory gates above PASS; missing-adapter default/production preview refusal and safe browser state exercised. Handoff reviewed against source exports and accepted authority model.
OPEN INTEGRATION GAPS: Accepted BE1 transport/navigation adapter, exact envelope/subcodes, server session cookie/CSRF contract, human-to-principal binding and live front-door qualification remain PRODUCTION_PROMOTION_BLOCKED / NOT_VERIFIED. Authenticated cross-device preference sync remains pending future approval.
NEXT: Freeze one owner-authorized immutable FE2 source candidate; stop for orchestrator review. Do not push, merge or deploy.

## Final gates / evidence / governance

`fe2-evidence/validation.json` preserves each mandatory frontend command, cwd, timestamps, stdout/stderr and exit code; all seven command gates exit 0. `premium-ui.json` records fresh strict static audit, zero findings. `security.json` records bounded changed-file scan with exact source hashes and its defense-in-depth limits. Four PNGs preserve representative synthetic desktop/narrow account and stale-conflict renders. Screenshots inspected against FE1 and shared design tokens; no CSS, token, typography, motion or overlay-owner changes. No generated configuration delta remains.

Security evidence: no browser auth storage/URL construction/cookie parsing in changed identity source; runtime allowlist strips token/claim/email/cookie extras; provider errors never render; no final browser authority calculation; stale/unauthorized/mismatched/unchanged-version writes fail closed; pending writes clear operational context; cancelled/late reads cannot restore old projections; no fake login/logout acknowledgement; synthetic fixtures use synthetic references only. Production smoke verifies default disabled sign-in, safe missing-service behavior, four new UI routes, absent fixture route and clean storage/headers. Preference sync returns pending only.

All mutations remain inside Agent A frontend source/tests/docs. Existing FE1 historical evidence and product-platform/server/API/package/config/backend source are preserved. Local `npm ci --ignore-scripts` installed locked dependencies without manifest changes. Loopback servers were bounded test harnesses and stopped. No root suite, `/tmp/q`, provider credential use, infrastructure mutation, external messaging, deployment, push, merge or branch change.

One source candidate commit is authorized by A-007. The post-commit FREEZE.json remains untracked and binds exact commit/tree/base/branch, all changed paths and SHA256 values, evidence hashes, gate exits and scope checks without changing the candidate. This is owner-authorized implementation/self-verification, not independent review or acceptance. Optional FE2.X and FE3 work not begun. Next action: orchestrator reviews the immutable candidate and separately owns acceptance/BE1 integration.
