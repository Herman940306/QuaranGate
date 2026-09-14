# P7 B4 — Trusted Local Companion Runtime Identity / IPC Confinement

**Status:** SOURCE FOUNDATION / NOT A LIVE IDE TRANSPORT

## Purpose

P7 B4 adds the local runtime-material boundary required between the accepted B3 authenticated request contract and any future live IDE companion listener. It remains source-only: no executor startup integration, gateway/executor route, MCP tool, production listener, provider/model call, workspace/worktree attestation, operation execution, persistent IDE operation audit, shared writer arbitration or vendor-live compatibility is added.

The B4 source surface is:

- `src/executor/ide/ideCompanionRuntime.ts` — trusted runtime-root validation, QuaranGate-generated runtime instance/path identity, owner-only credential material, explicit secret rotation/revocation and Unix-socket type/ownership/mode verification;
- `src/executor/ide/ideCompanionRuntimeAdmission.ts` — trusted wrapper that re-reads the current runtime credential for every B3 admission so stale cached secrets cannot silently bypass rotation/revocation;
- `tests/unit/ide-companion-runtime.test.ts` — filesystem, identity, credential, rotation/revocation and test-only socket validation;
- `tests/unit/ide-companion-runtime-admission.test.ts` — B4-to-B3 admission integration, stale-secret, revocation and cross-runtime binding tests.

## Trusted path model

B4 accepts one `runtimeRoot` only as trusted executor/config input. It is not a field in any companion frame or public request schema.

A runtime root must be:

- absolute and already canonical (`path === resolve(path)`);
- a real directory, not a symlink;
- owned by the current Unix user;
- mode exactly `0700`;
- canonical through every path component (`realpath === configured path`);
- beneath an ancestor chain that contains no group/world-writable non-sticky directory.

This permits safe sticky shared ancestors such as `/tmp`, while refusing a path whose ancestor can be replaced by another Unix identity through an ordinary writable directory.

QuaranGate generates a 128-bit opaque `iderun_<hex>` runtime instance identity. The runtime directory and fixed child names are derived from that identity only:

```text
<trusted runtime root>/iderun_<opaque>/credential.json
<trusted runtime root>/iderun_<opaque>/companion.sock
```

The companion does not choose either path. B4 refuses a forged runtime reference whose directory, credential path or socket path differs from these derived values. Socket paths are bounded to a conservative 100 UTF-8 bytes before the runtime directory is created.

## Adapter/runtime identity

B4 closes adapter identity by IDE product:

```text
vscode        -> quarangate-vscode-companion
kiro          -> quarangate-kiro-companion
cursor        -> quarangate-cursor-companion
visual-studio -> quarangate-visual-studio-companion
antigravity   -> quarangate-antigravity-companion
```

The runtime credential binds exact:

- credential format version;
- runtime instance ID;
- enrollment ID;
- IDE instance ID;
- IDE product;
- derived adapter ID;
- exact trusted adapter version string;
- secret generation;
- fixed socket path;
- active/revoked state.

This is metadata binding only. B4 does **not** claim that a running extension/process binary has been remotely attested or that an IDE/version compatibility matrix is qualified. Those are later live-adapter gates.

## Credential confidentiality and integrity

Active credential material is stored only in the runtime directory and is forced to mode `0600`. The credential parser:

- opens with `O_NOFOLLOW` where available;
- verifies a regular file, current Unix UID, exact `0600` mode and bounded size;
- requires one canonical single-line JSON record plus one trailing newline;
- rejects unknown/missing fields, duplicate/noncanonical encodings, unsupported format version and identity substitution;
- re-derives the expected adapter ID and exact runtime paths;
- requires a 32-byte high-entropy base64url secret, compatible with the accepted B3 secret-length policy.

No secret is included in `IdeCompanionRuntimeRef`, B3 authenticated request frames, admission results, logs or registry replay rows.

## Rotation and revocation

Every trusted secret read re-opens and re-validates the credential file. B4 therefore does not rely on a long-lived secret cache.

Rotation:

1. revalidates the active credential;
2. increments the positive safe-integer secret generation;
3. generates a fresh 32-byte random secret;
4. writes a unique owner-only temporary file;
5. fsyncs it;
6. atomically renames it over the credential;
7. re-verifies mode/type and fsyncs the runtime directory.

Revocation atomically replaces the active record with a `REVOKED` record, increments generation and removes the raw secret field entirely. A revoked runtime cannot be rotated back to active; re-enrollment requires a fresh runtime instance.

The B4 runtime-admission wrapper re-reads the current credential immediately before accepted B3 admission. It also requires the B3 envelope enrollment ID and IDE instance ID to match the runtime binding. Thus:

- a frame signed with the old secret fails immediately after rotation;
- a revoked runtime fails before B3 replay/authority admission;
- one runtime secret cannot be used to authenticate a different enrollment/IDE instance;
- the temporary secret Buffer used by the wrapper is zeroed in a `finally` path after success or failure.

Cryptographically invalid old-secret attempts do not consume B3 replay state, preserving the accepted B3 ordering.

## Socket confinement source contract

B4 does not bind or listen on a production socket. It exposes only a validator/hardener for a socket created by a later transport gate.

The endpoint must exist at the exact QuaranGate-derived socket path and be:

- a Unix-domain socket;
- not a symlink;
- owned by the current Unix user;
- mode `0600` after hardening.

Tests create a temporary test-only Unix server solely to prove the positive socket type/mode branch. No production source imports `node:net` or calls `listen()`.

## Explicit residual: same-UID local processes

`0700` directories and `0600` files are a Unix ownership boundary. They prevent access by other Unix identities, but they are **not** a security sandbox against a hostile process already running as the same UID. A same-UID process can potentially inspect or race user-owned filesystem state depending on the host/runtime environment.

Therefore B4 does **not** claim:

- complete spoof resistance against arbitrary same-UID malware;
- process-binary attestation;
- peer-process identity proof;
- live extension authenticity;
- host air-gap or IDE-host egress qualification.

A later live-transport/vendor gate must qualify the actual adapter bootstrap/delivery mechanism, process/peer properties available on that host, endpoint bind lifecycle and residual same-UID threat. B4's owner-only filesystem controls must not be represented as stronger evidence than they are.

## No authority expansion

B4 adds no project/worktree/workspace claim and no mutation authority. It does not add `request_implementation`, a writer lease, target/filesystem/terminal authority, Docker authority, network authority, provider/model selection, arbitrary command execution or caller-selected host paths.

The accepted B3/B2/B1 chain remains the only request admission path, with `writerLease=none`.

## Validation

Focused B1-B4 source suites currently pass `94/94` tests across:

- common IDE authority/lifecycle contract;
- Plane-B registry and durable replay;
- B3 cryptographic envelope;
- B3 canonical admission;
- B4 runtime material/confinement;
- B4 fresh-credential runtime admission.

Typecheck passes on the current B4 candidate.

Whole-root unit validation on the final B4 candidate passes `2352/2352` tests across `72/72` files. Typecheck PASS; build PASS; `git diff --check` PASS; console-catalog `4/4 PASS`; B4 does not modify the public MCP catalog, which remains the accepted exact 45-tool surface. No live IDE, startup, deployment or vendor qualification is claimed by this document.

## Continuation boundary

After B4 acceptance, the next P7 gate must again be derived from the current North-Star/security ordering. Remaining prerequisites include canonical IDE workspace/worktree attestation, actual local listener/startup lifecycle, operation/event/cancellation execution, persistent attribution/audit, shared live-writer arbitration and vendor-specific qualification. No one of those is implied by B4 source acceptance.
