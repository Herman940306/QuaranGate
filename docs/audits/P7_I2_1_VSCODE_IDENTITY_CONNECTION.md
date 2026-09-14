# P7 I2.1 — VS Code Production Identity / Workspace Connection

**Status:** SOURCE FOUNDATION / B6-AUTHENTICATED CLIENT ONLY / NO CHAT OR OPERATION EXECUTION / NOT STARTUP-WIRED / NOT DEPLOYED

## Purpose

I2.1 replaces the preserved S1 spike's private runtime/secret/socket authority model with a production client foundation that consumes the already accepted B4/B5/B6 contracts. The VS Code side is an authenticated client of QuaranGate's owner-controlled local AF_UNIX listener. It does not create a second IDE authority server and it cannot acquire a controller or originate a B7/B9 operation in this batch.

The S1 spike remains untouched feasibility evidence. Only its proven architectural facts are carried forward: a Remote-WSL workspace extension can mechanically observe one workspace and can use local Unix-domain IPC. Its ad-hoc shared-secret request protocol is not promoted.

## Source added

- `src/ide-adapters/vscode/vscodeCompanionCredential.ts`
  - consumes exactly the executor-generated B4 `credential.json` bootstrap;
  - validates owner/type/mode/canonical-path/ancestor safety;
  - requires `ideProduct=vscode`, adapter `quarangate-vscode-companion`, exact trusted SemVer build identity and QuaranGate-derived `companion.sock`;
  - rejects revoked, malformed, noncanonical, substituted or unsafe credential material;
  - returns mutable 32-byte secret material so callers can zero it after use.

- `src/ide-adapters/vscode/vscodeWorkspaceCollector.ts`
  - accepts no logical project/worktree ID and executes no shell command;
  - requires Remote-WSL workspace-host placement and exactly one `file:` workspace folder;
  - proves exact realpath identity and qualified case-sensitive filesystem type;
  - derives B5 filesystem identity from device/inode and WSL environment identity from a bounded canonical machine-id;
  - mechanically resolves Git worktree/common-dir identity and exact lower-case SHA-1 HEAD from loose or packed refs without invoking Git;
  - fails closed on symlinks/aliases, ambiguous/multi-root workspace, unsupported filesystem, malformed metadata or unresolved Git identity.

- `src/ide-adapters/vscode/vscodeCompanionConnection.ts`
  - opens only the exact B4-derived AF_UNIX socket;
  - emits one canonical B6 `hello` and validates one bounded canonical challenge;
  - constructs exact B5 attestation bytes from collected physical evidence;
  - signs the B6 domain-separated challenge using current bootstrap secret material;
  - requires the exact challenged session/generation in `ready`;
  - zeroes bootstrap secret material on both success and failure;
  - exposes only the established AVAILABLE connection and `close()` in I2.1;
  - sends no controller-acquire, review, implementation or cancellation frame.

## Authority ordering

I2.1 preserves the accepted authority sequence:

1. trusted executor enrollment/runtime creation remains server-side;
2. VS Code consumes only the exact owner-only B4 credential path supplied by installation/enrollment;
3. the VS Code extension host mechanically collects physical workspace evidence but supplies no logical authority IDs;
4. B6 authenticates the runtime secret and exact challenge/session/generation;
5. B5 on the QuaranGate side compares the attested physical workspace against trusted Plane-B enrollment;
6. only then does the session become `AVAILABLE`;
7. no controller lease or operation exists yet.

A credential is therefore bootstrap material, not authorization to choose project/worktree or mutate source.

## Adversarial evidence

New deterministic tests prove:

- exact active VS Code B4 credential acceptance;
- adapter-version drift denial;
- revoked credential denial;
- wrong IDE/adapter denial;
- unsafe credential mode denial;
- noncanonical JSON denial;
- socket-path substitution denial;
- non-sticky writable ancestor denial;
- exact Remote-WSL workspace-host requirement;
- exactly one workspace folder;
- symlink workspace denial;
- URI/path alias denial;
- unsupported filesystem denial;
- machine-id validation;
- Git directory/worktree/common-dir identity and HEAD resolution;
- malformed/missing Git ref denial;
- real B4 -> B5 -> B6 connection promotion to AVAILABLE;
- connection close -> durable DISCONNECTED;
- authenticated physical-workspace drift never becomes AVAILABLE;
- the identity handshake grants no controller and starts no operation;
- bootstrap secret is zeroed after successful and failed handshakes.

## Validation on final executable/test bytes

- I2.1 focused tests: **22/22 PASS across 3 files**.
- P7 + shared live-writer/apply regression, executed in bounded worker-safe chunks: **584/584 PASS across 23 files**.
- Full unit corpus, every repository unit file: **2515/2515 PASS across 84/84 files**, executed as bounded per-file/process runs because this governed worker currently kills long-lived Vitest fork pools.
- Canonical one-shot `npm test`: **BLOCKED_ENVIRONMENT / exit 137 before assertion output** in this worker. This is the same worker-pool/resource limitation independently documented at B9.3; it is not relabeled PASS. All 84 files were then executed and passed through bounded processes.
- TypeScript typecheck: PASS.
- Build: PASS.
- `git diff --check`: PASS.
- Console/catalog tests: **30/30 PASS across 4 files**.
- Public MCP tool catalog: exact **45 expected / 45 server / missing 0 / extra 0**.
- Source-graph scan: no import of `src/ide-adapters/vscode/*` from executor startup or gateway/public tool surface.

## Explicit non-claims

I2.1 does **not** claim or provide:

- complete I2 or P7 acceptance;
- executor startup wiring or deployment;
- VS Code extension manifest/package activation;
- a Chat Participant or human-visible turn;
- Language Model API access/model selection/consent qualification;
- QuaranGate-originated operation delivery to the extension;
- review or implementation adapter execution;
- editor-context access;
- generic host command/shell/filesystem authority;
- Windows-local extension-host support or named-pipe fallback;
- Cursor/Kiro/Visual Studio/Antigravity compatibility;
- IDE-host egress/air-gap qualification;
- hostile same-UID process isolation;
- a claim that VS Code public APIs inject machine turns into standard Chat history.

## Next bounded I2 slice

The next I2 slice must define one versioned QuaranGate-origin command/event channel over the already authenticated B6 connection, without creating a second authority plane. It must preserve B7/B9 operation IDs, generation/controller/writer rules, bounded ordered events and exact cancellation. Only after that transport is accepted may a VS Code public-API agent/Chat Participant core be attached and independently qualified.
