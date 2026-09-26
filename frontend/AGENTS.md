<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->


## QuaranGate mandatory frontend design precheck

STOP before any frontend mutation. Read ../docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md in full.

It is the owner-directed normative visual-design contract for this frontend. Existing functional implementation and passing tests are a behavioral/security baseline, not proof that the owner's final visual design is complete.

All frontend implementation, remediation, testing, screenshots, design-system changes, route work, refactors and reviews must preserve accepted behavior/security while conforming to that document and ../DESIGN.md.

Required handoff fields:

FRONTEND_VISUAL_SOT_READ=YES
FRONTEND_VISUAL_SOT_PATH=docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md
DESIGN_CONFORMANCE_SCOPE=<checked or changed scope>

If the source-of-truth file cannot be read, do not modify frontend source.
