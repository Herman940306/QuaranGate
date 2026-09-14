# P7 B5 — Backend-Neutral IDE Workspace / Worktree Attestation

## Scope

P7 B5 freezes a source-only canonical workspace/worktree attestation contract and trusted comparison layer. It does not add a listener, startup route, public MCP/HTTP surface, IDE operation execution, provider/model invocation, persistent IDE-operation audit, shared writer authority, or vendor-live qualification.

## Authority boundary

Adapter evidence is evidence, not authority. The attestation object deliberately carries no trusted `projectId`, `worktreeId`, or caller-selected workspace fingerprint. QuaranGate retrieves the durable Plane-B enrollment, re-derives the workspace fingerprint using trusted project/worktree IDs plus the physical attestation, and compares it to the enrolled fingerprint.

Authenticated B3/B4 admission identity is separately bound to enrollment, IDE instance, session, connection generation, runtime instance, IDE product, adapter ID and adapter version before physical workspace evidence can be accepted.

## Canonical evidence

Version 1 is strict canonical JSON, bounded to 16 KiB, fatal UTF-8, exact keys, exact one workspace folder, and a closed vocabulary for remote kind, path flavor and case mode.

The physical identity covers:

- exact canonical `file:` URI and canonical path;
- `realpath-exact` canonicalization claim;
- stable environment identity digest;
- stable filesystem identity digest;
- exact Git worktree root when Git is present;
- Git common-directory path and identity digest;
- exact 40-hex Git HEAD as transient/base-revision evidence.

POSIX evidence rejects root, relative, normalized aliases and backslashes. Current remote kinds require POSIX evidence. Local Win32 evidence requires one canonical uppercase local drive path; UNC, drive roots and aliases fail closed.

## Fingerprint model

The stable workspace fingerprint is SHA-256 over a domain-separated canonical tuple containing trusted project/worktree identity plus remote/environment/path/case/canonical URI/path/filesystem identity and stable Git worktree/common-directory identity.

Session ID, connection generation, runtime instance and Git HEAD are intentionally excluded from the stable fingerprint. They are validated separately. This lets reconnect/runtime renewal and normal Git advancement remain lifecycle state rather than silently redefining workspace identity.

If a trusted enrollment pins `baseRevision`, accepted evidence must be a Git worktree and its current HEAD must exactly equal that revision.

## Fail-closed cases covered

Tests cover malformed/oversized/invalid-UTF8 frames, canonical JSON drift, future versions, multi-root workspace claims, unsupported remote/path combinations, path/URI aliases, POSIX/Win32 edge cases, Git common-directory substitution, invalid HEAD, trusted project/worktree fingerprint binding, B3 payload mismatch, authenticated identity drift, B4 runtime identity substitution, stale reconnect generations, revoked enrollment, terminal session, forged runtime references and pinned/non-Git base-revision behavior.

One implementation defect was found before freeze: the first B5 SemVer regex omitted the patch component and rejected valid `1.2.3`. It was corrected before final validation. Later failures were deterministic test-fixture identity collisions and required no source-policy weakening.

## Validation

- B5 focused attestation/verifier: 20/20 PASS.
- P7 B1-B5 focused regression: 114/114 PASS across 8 files.
- Full root unit suite: 2372/2372 PASS across 74/74 files.
- TypeScript typecheck: PASS.
- Build: PASS.
- `git diff --check`: PASS.
- Console catalog regression: PASS; public MCP tool surface remains unchanged at exact 45 tools.

A first full-root shell invocation supplied `--configLoader native` twice and exited before test execution. The canonical `npm test` command was then run exactly as defined by the repository and passed 2372/2372. The wrapper error caused no source mutation and is not a test failure.

## Explicit residual / non-claim

B5 verifies authenticated canonical evidence against trusted enrollment. It does **not** independently prove that a vendor adapter truthfully collected filesystem/environment/Git facts from the operating system, nor does it attest a peer process/binary. That requires the later production companion/listener and vendor-adapter qualification gates.

B5 is therefore a source foundation, not live IDE/workspace qualification.
