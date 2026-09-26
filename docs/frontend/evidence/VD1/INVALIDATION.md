# VD0 / VD1 provenance invalidation and stopped handoff

FRONTEND_VISUAL_SOT_READ=YES
FRONTEND_VISUAL_SOT_PATH=docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md
DESIGN_CONFORMANCE_SCOPE=VD1 shared CSS, fonts and primitive state markers; unqualified draft

STOPPED: pre-existing development server in the exact active frontend worktree. Listener 127.0.0.1:3100: next-server PID 480503, parent PID 480491 (`node …/frontend/node_modules/.bin/next dev`), started 2026-09-26 19:03:30. A separate Playwright test-server PID 327402 also has this repository cwd. Ownership and concurrent generated-output writes are not resolved. No unowned process was terminated. The earlier restricted process namespace showed only the agent; it was insufficient to establish host-level exclusive ownership after access changed.

VD0 was committed at fdc2c6d843b341e6010bf5c88e20f5cf2516dfd9, tree 714437c33d501947669a65265d9c1ef93b9b5a30, parent ed8665ffd45352fc3d3a5cba61ae9ddfda117ef5, subject `test(frontend): freeze VD0 rendered visual baseline`. Its bytes are preserved. This new receipt supersedes its claim to a production-rendered baseline. No frozen evidence is rewritten.

Root cause: capture.mjs spawned a production server, discarded its output, and treated a successful HTTP response at 3100 as readiness without checking child exit, port ownership or process identity. The pre-existing dev listener responded. Consequently VD0/VD1 screenshots are real rendered images but have unverified build/server provenance. VD0 is NOT a qualified phase freeze; VD1 is NOT frozen. The capture helper must not be reused as qualification without fixing that ownership failure. Current .next output is shared with the pre-existing dev process and is not immutable bundle proof.

Production E2E invocation exited 1 with `http://127.0.0.1:3100 is already used`. No tests ran. This is an environment/harness ownership failure, not a demonstrated product regression. It remains blocking. No final visual/functional acceptance is asserted.

Draft changes: normative default warning/danger values, derived contrast-safe warning chip text, 16px panel rhythm, compact route typography and local 700 font asset, explicit button intent styling, state markers, code-owned horizontal overflow, and FE2/FE3 screenshots redirected to runner output to prevent historical overwrite. Existing API calls, identity/remount/stale/cancellation and confirmation logic are untouched. No backend/dependency/credential/authority expansion occurred. Source changes remain unstaged and uncommitted for review.

Fresh commands: typecheck exit 0; lint exit 0; unit exit 0 (164/164); build exit 0; audit exit 0 (zero vulnerabilities); bounded secret scan PASS. Typecheck/lint/unit preceded the final contrast-derived chip adjustment and screenshot-path redirect; they are not final-draft qualification. Build/audit/scan followed those adjustments, but shared generated-output ownership prevents final bundle qualification. Captures: 48 per phase, source HEAD/tree and viewport in capture.json; rendered screenshot inspection of all VD0 top regions and representative VD1 Overview desktop/Terminal narrow occurred. Provenance remains unverified, so neither inspection is VISUAL_CONFORMANCE_PASS.

Historical preservation: every original 32 tracked PNG hash from VD0/historical-hashes.json remains unchanged; frozen VD0 evidence checksums also remain unchanged. Exact Figma artifact is NOT_IDENTIFIED; FIGMA_CONFORMANCE_VERIFIED=NOT_VERIFIED.

NEXT_EXACT_ACTION: owner resolves/relinquishes pre-existing server/test-server ownership for this lane. Then recheck worktree/writer identity, fix capture readiness to verify owned child and exclusive port without reusing a server, use isolated generated output, rebuild, and recapture VD0 in a NEW evidence directory. Requalify the preserved VD1 draft only after a valid VD0 freeze. Do not overwrite VD0/FE evidence, discard draft changes, or proceed to VD2 yet.
