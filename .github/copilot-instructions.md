# QuaranGate repository instructions

QuaranGate is a security-sensitive governed AI engineering control plane. Treat source state, authority boundaries, and acceptance evidence as first-class correctness constraints.

## Working rules

- Never assume repository, branch, HEAD, runtime, test, deployment, provider, or acceptance state. Verify the exact state relevant to the task.
- Never claim a check passed unless its output was actually observed for the exact candidate being discussed.
- Preserve one-writer-per-worktree discipline. Do not mutate a worktree that another agent or engineer owns.
- Keep implementation, review, acceptance, deployment, and release as separate gates.
- Do not rewrite frozen historical audit evidence to make old state appear current.
- Do not introduce secrets, tokens, credentials, private source, or real customer data into code, tests, docs, prompts, logs, or examples.
- Prefer deterministic fail-closed behavior over permissive fallback when state, identity, authority, provenance, or recovery is ambiguous.

## Security boundaries that must not be weakened casually

- Network-facing components must not gain raw Docker authority.
- Callers must not choose arbitrary host paths, bind mounts, images, network modes, or privilege flags.
- Live-source mutation must remain separately authorized from agent generation/review.
- Stored evidence reviewed must be the evidence promoted; do not accept caller-supplied replacement patches at apply time.
- Authentication, authorization, workspace confinement, stale-state protection, guarded paths, rollback/quarantine, and bounded execution are security controls, not optional convenience features.
- Local inference does not imply no egress; analyze every process with network authority.

## Engineering expectations

Before proposing or changing code, identify the exact affected trust boundary and tests. Use existing project patterns before inventing a parallel control path. Keep changes bounded. Add adversarial regression coverage for every security or lifecycle defect fixed.

Typical validation includes `npm run typecheck`, `npm test`, `npm run build`, `git diff --check`, focused tests, and applicable security/release gates. Environment-blocked checks must remain classified as blocked, not passed.

For current architecture and product truth, prefer the current README and organized documentation under `docs/`. Frozen records under `docs/audits/` are historical evidence.
