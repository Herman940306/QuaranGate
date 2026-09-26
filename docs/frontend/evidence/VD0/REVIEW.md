# VD0 rendered baseline

FRONTEND_VISUAL_SOT_READ=YES
FRONTEND_VISUAL_SOT_PATH=docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md
DESIGN_CONFORMANCE_SCOPE=Baseline capture of 24 product routes, 1280x900 and 360x900

Source HEAD ed8665ffd45352fc3d3a5cba61ae9ddfda117ef5; tree 1c3687fe90ae8eba99ab49dced4830db42167786; parent 2bab51ce1019546e028c28cffa49aab2f7daf08d. Clean source/index prestate; process inventory showed no competing writer in the visible environment. No external writer lease is claimed.

Fresh production build PASS. 48 new full-page screenshots, route/viewport measurements and synthetic-state descriptions are enumerated in capture.json. Production identity/configuration integration remains pending. MCP is intercepted as unavailable; reads are still explicit except Statistics. No live credentials, data or mutation are used. Desktop and narrow top-region contact sheets were inspected for all 24 routes; Overview desktop and Targets narrow were also inspected individually. This baseline review is not exhaustive populated-state or final visual acceptance.

Observed: oversized desktop route headings dominate operational content; rail is already 248px but ungrouped and important lower routes require rail scrolling; baseline panel rhythm is 20px rather than 16px; nested panels repeat border treatments; normal authority notices use machine-black surfaces; authority classes have no recurring shared strip across all routes; high-impact button intents exist in markup but have no CSS intent differentiation. Some headings carry presentation-only authority wording while production identity remains unintegrated. No page horizontal overflow was measured across the 48 captured states. Narrow state is readable but lengthy and authority notices consume substantial vertical space.

Next: VD1 token/primitive convergence, followed by shell grouping and structural authority in VD2. Preserve existing semantics, backend calls and cancellation. Exact Figma artifact has not been identified: FIGMA_REFERENCE_AVAILABLE=NOT_IDENTIFIED; FIGMA_CONFORMANCE_VERIFIED=NOT_VERIFIED. DESIGN.md and visual source of truth permit bounded structural work; pixel-critical final acceptance is blocked pending an approved reference.

Historical tracked PNG hashes are recorded in historical-hashes.json. SHA256SUMS.json inventories new evidence. Existing FE evidence has not been overwritten. capture.mjs and manifest.py are reproducibility helpers, not product runtime; capture.mjs requires installed frontend dependencies and a fresh production build, runs a disposable loopback server, and writes only to the requested new phase directory.

Status: frozen implementation baseline candidate, not self-accepted. Functional behavior unchanged. No new source validation or independent acceptance is inferred from capture success.
