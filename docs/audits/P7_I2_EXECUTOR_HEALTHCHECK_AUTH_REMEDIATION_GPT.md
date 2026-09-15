# P7 I2 — Executor `/readyz` healthcheck authentication remediation

## Status

`SOURCE_REMEDIATION_CANDIDATE`

## Frozen blocker

Live qualification of accepted source `d720f0f912ed24f876c9e24fa47b281a58dd87b2` proved a source/configuration mismatch: the executor Docker healthcheck called `GET /readyz` without the executor's required `x-internal-token` header. The same source exempts only `/healthz` from internal authentication. The live result was therefore `401 UNAUTHENTICATED` for the Docker healthcheck while the same `/readyz` request with the internal token returned `200 READY` and proved Docker authority.

This remediation does not reinterpret that result as an environment failure and does not use a qualification-only overlay.

## Remediation

The executor healthcheck remains an authority-readiness probe against `/readyz`, but now supplies the existing executor `INTERNAL_TOKEN` as `x-internal-token` from `process.env.INTERNAL_TOKEN` inside the container.

The credential value is not embedded in Compose command bytes. Executor startup already fails closed if `INTERNAL_TOKEN` is unset or left as the placeholder value.

## Rejected weaker alternatives

- Do not switch the executor healthcheck to `/healthz`; that would reduce authority-readiness to process liveness.
- Do not exempt `/readyz` from executor authentication; that would weaken the private executor API boundary.
- Do not use a qualification-only override; qualification must exercise the source candidate being accepted.

## Regression contract

`tests/unit/gateway-readiness.test.ts` now requires the executor healthcheck to:

- target `/readyz`;
- not fall back to `/healthz`;
- send `x-internal-token`;
- derive the header from `process.env.INTERNAL_TOKEN`;
- avoid embedding a literal header credential in the healthcheck command.

## Scope

This patch changes no executor route semantics, no public network surface, no Docker authority, no IDE authority, no provider behavior, and no project-control state.

## Operational cleanup before remediation

The blocked d720 qualification boundary was cleaned before source mutation:

- Remote-WSL Machine `settings.json` restored byte-for-byte: SHA-256 `c6fc408067761dfca2de20c9cbfcb9a8fbebbe4545007b038746ea8e004db2eb` equals the preserved pre-run backup.
- Qualification Compose project `quarangate-i2-bwenppjv`: no remaining containers or project volumes when independently rechecked.
- Qualification-owned Windows VS Code process query for token `BweNpPJv`: no remaining process.
- Frozen blocked evidence was copied from `/tmp` to `/home/herman/.local/state/quarangate/p7-i2-live-BweNpPJv/evidence-blocked-d720` with hashes preserved:
  - evidence tar: `89a5a7f512d0e69b5de0a2c09a1abc801f969ceaecd0faa3d2877738c6ebee33`
  - qualification evidence: `dd5bb6cc6c02b180fea14af4a2fed7bf18de0e911e1fd3e3fbab558bec39325e`
  - blocker record: `834b78a7c852e8bb3d33782c0432f85aae6e72fbd907fb7a7ed1dce96aef63da`
  - files manifest: `defd7a0f3c87d59c2f0f82a54154eedec0ac87271a48c52adc08882ab127f34f`

## Source validation

- Focused `tests/unit/gateway-readiness.test.ts`: **22/22 PASS**.
- Relevant IDE/startup/config regression: **151/151 PASS across 5 files**.
- Canonical `npm test`: **NOT PASS** — Vitest/Tinypool process was killed with exit `137` before corpus completion in the constrained `projects-work` environment. This result is preserved and not reclassified.
- Bounded fresh-process fallback over every `tests/unit/*.test.ts` file on the owner host: **92/92 files, 2612/2612 tests PASS**.
- Typecheck on owner host using the accepted dependency tree: **PASS**.
- Build on owner host using the accepted dependency tree: **PASS**.
- `git diff --check`: **PASS**.
- Host `docker compose config --format json` with a disposable token: **PASS**; rendered executor healthcheck targets authenticated `/readyz`, references `process.env.INTERNAL_TOKEN`, and does not embed the disposable token value.
- No new Docker socket exposure, published port, privileged mode, capability, public route, provider authority, IDE authority, or project-control mutation is introduced by this patch.

`gitleaks` is not installed in the governed source container. No download was authorized. Changed bytes are therefore checked with a bounded credential-pattern scan rather than silently acquiring a new scanner.
