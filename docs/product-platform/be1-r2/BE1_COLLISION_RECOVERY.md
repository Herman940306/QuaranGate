# BE1-R2 Same-Worktree Collision Recovery

## Incident binding

External incident receipt:
`/home/herman/projects/QuaranGate-agent-orchestration/incidents/BE1_SAME_WORKTREE_COLLISION_20260926.txt`

SHA-256:
`4a4d8ac8e0476245f91b96de260fa32c9f3107549a02c59805c13f97c5398eb9`

R2 preflight independently recomputed that exact digest before implementation.

The contaminated worktree `/home/herman/projects/QuaranGate-product-be1-gpt` was inspected read-only only. Its HEAD remained `5fc68fe23918dfca764a3b5e6de8eb73ede2167c` / tree `3a490302868c035460fe730f19cce30ca647243b`. It was not cleaned, reset, stashed, committed, deleted, patched or otherwise mutated.

## Recovery rule

R2 was rebuilt from accepted common-base contracts and B-005. No source fragment was copied from the contaminated worktree. Therefore there is no collided source path to adopt as authority or provenance.

The canonical R2 product-server namespace is exactly:

`frontend/src/server/product/**`

The canonical BE1 API namespace is exactly:

`frontend/src/app/api/product/**`

Canonical routes:
- `GET /api/product/auth/login`
- `GET /api/product/auth/callback`
- `GET /api/product/session/current`
- `POST /api/product/session/workspace`
- `POST /api/product/session/logout`

R2 must contain no BE1 sibling implementations under `frontend/src/server/auth/**`, `frontend/src/server/identity/**`, `frontend/src/server/session/**`, or `frontend/src/server/authority/**`.

## Ownership

Agent A's F1 worktree is separate. BE1-R2 does not modify Agent A UI/client components, `frontend/src/lib/client/**`, `frontend/src/lib/operational/**`, visual primitives, or `frontend/next.config.ts`.

Only BE1-owned server/API/test/docs paths and BE1 server dependency entries in `frontend/package.json` / `frontend/package-lock.json` may change.
