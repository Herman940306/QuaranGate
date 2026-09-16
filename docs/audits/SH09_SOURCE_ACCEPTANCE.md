# SH-09 Source Acceptance Receipt

## Verdict

`OWNER_AUTHORIZED_STRICT_SELF_AUDIT_PASS / SH09_SOURCE_ACCEPTED`

This receipt records owner-authorized strict self-audit of the immutable SH-09
source candidate. It is **not** independent review, live Docker chaos
certification, external penetration-test certification, P10/A9 production
qualification, P11 release approval, or production promotion.

## Immutable source identity

- Canonical base: `1ff9be05037173becd634490022ac1d88cda21a4`
- Implementation commit: `c50d5a7975e9c54fb7bc28b43d54ceb0113b2dfc`
- Implementation parent: `1ff9be05037173becd634490022ac1d88cda21a4`
- Subject: `security(sh09): harden apply crash recovery`
- Implementation tree: `041d63dd296716b3e81cf63ca59d545ad2b08b74`
- Implementation path count: `14`
- Immutable patch SHA-256: `1e9734f0d4ec6db3a189abdd4dc93a21631ca5841d25641365ce4dd52aee4a19`
- Content-manifest SHA-256: `ca62b5ad17bc1d77eea327807ef90e732d0c5ef215700cd82109dadd6b8f5eef`

Independent immutable diff reproduction matched the staged candidate patch hash.

## Security finding and remediation

SH-09 found a real fail-closed crash-recovery defect in
`RunnerSandbox.reconcileOrphans()`:

- managed Docker inventory errors could be converted to empty lists;
- container/volume/network removal failures could be swallowed while resources
  were still reported as removed.

For a crashed `agent_apply`, that could allow a stale mutation-capable applier
container or other managed resource to survive restart while startup continued.

The accepted remediation makes reconciliation fail closed:

- managed inventory failures propagate;
- container stop remains best-effort only because an already-stopped container
  may reject `stop`;
- forced container removal must succeed before it is reported removed;
- eligible managed volume/network removal must succeed before success is
  reported;
- existing startup ordering keeps `listen()` behind successful orphan
  reconciliation, so unresolved mutation-capable resources block executor
  availability.

No Docker authority/API expansion was introduced.

## Real process-death durability proof

The accepted SH-09 chaos matrix uses disposable on-disk SQLite databases in WAL
mode and real child-process `SIGKILL` through `node --import tsx`. It proves:

1. `STARTED` and `VERIFYING` crashes remain recoverable as proven no-host-
   mutation attempts and release writers without quarantine;
2. committed `APPLYING` state/journal crashes recover conservatively to
   `UNCERTAIN` with project quarantine and preserved durable journal;
3. committed verified success remains `VERIFIED_SUCCESS` / `APPLIED` /
   `RELEASED` across restart;
4. torn uncommitted cross-table success writes expose no partial success after
   reopen;
5. torn uncommitted recovery writes expose no partial recovery state;
6. injected SQLite recovery failure rolls back atomically and can be retried;
7. repeated restart/recovery remains idempotent and fail closed.

The chaos fixture kills only itself, uses disposable test databases, and does
not invoke live Docker, providers, network or valuable worktrees.

## Exact immutable qualification

Executed against implementation commit
`c50d5a7975e9c54fb7bc28b43d54ceb0113b2dfc`:

- full unit suite: `139/139 files`, `2944/2944 tests` PASS;
- TypeScript typecheck: PASS;
- TypeScript build: PASS;
- `security:invariants`: `15/15` PASS;
- SH-08 `security-fuzz`: PASS;
- SH-09 `security-chaos`: `2/2 files`, `14/14 tests` PASS;
- `git diff --check`: PASS;
- `/tmp/q`: absent after validation;
- cgroup `oom_kill`: `17 -> 17`;
- changed tests contain no `.skip`, `.todo` or `.only` weakening.

The actual release-receipt machinery independently produced exact clean-source
and `security-chaos=PASS` receipts for this commit/tree. The full
`release:assurance` result remained `BLOCKED_ENVIRONMENT`, not PASS. Intrinsic
source gates passed, including typecheck, build, unit, authority-invariants,
security-fuzz, security-chaos and SBOM. Integration, E2E, external scanners,
image scanning and provenance remained unavailable only for their already-
recorded environment/tooling prerequisites.

## Security conclusion / non-claims

The exact-byte self-audit found no authority expansion. The only runtime source
change is stricter fail-closed orphan reconciliation; release-framework changes
only make `security-chaos` a mandatory fixed evidence gate.

SH-09 does **not** claim:

- live Docker-daemon crash testing against valuable state;
- host power-loss/fsync hardware-fault simulation;
- SSRF/egress qualification (SH-10);
- hostile Docker-world qualification (SH-11);
- prompt-injection campaign (SH-12);
- IDE/same-user adversarial campaign (SH-13);
- independent external penetration testing (SH-14);
- enterprise operational-security closure (SH-15);
- unavailable scanner/browser/integration/provenance release gates;
- P10/A9 or P11 completion.
