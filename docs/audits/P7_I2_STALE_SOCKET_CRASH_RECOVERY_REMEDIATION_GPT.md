# P7 I2 stale companion socket crash-recovery remediation — ChatGPT author record

## Authority and scope

- Owner: Herman
- Author: ChatGPT / isolated remediation lane
- Branch: `fix/p7-i2-stale-socket-crash-recovery-gpt`
- Base: `474647649ae3548790cfd8f415bb160f1bff1d2b`
- Acceptance authority: independent reviewer only; this document is **not** an independent review.
- Canonical forward/control were not mutated while this remediation was authored.

## Live defect reproduced on the accepted I2 healthcheck source

A fresh isolated VS Code/Remote-WSL qualification on exact source `474647649ae3548790cfd8f415bb160f1bff1d2b` proved the provider-independent I2 transport path through reconnect, workspace-drift denial, governed review, cancellation, disconnect, and bounded backpressure.

During the hard-restart gate a real durable `request_review` operation was RUNNING on generation 10 when only the isolated qualification executor was sent `SIGKILL`.

Durable recovery itself behaved conservatively after restart attempt:

- interrupted operation -> `INDETERMINATE`
- event sequence ended with `indeterminate`
- generation-10 session -> `STALE`
- no false completion
- no writer/mutation authority was involved

However, executor startup then exited 1 because the process-death orphan remained at the exact trusted runtime path:

`IDE companion socket path already exists`

The orphan was an owner-owned Unix socket with mode `0600`; the runtime directory and credential remained owner-controlled at `0700`/`0600`.

## Remediation

`IdeCompanionListener.start()` now handles a pre-existing endpoint with a narrow fail-closed stale-socket recovery algorithm:

1. If the endpoint is absent, behavior is unchanged.
2. If present, `lstat` must prove an actual Unix socket, not a symlink, owned by the current Unix uid, mode exactly `0600`.
3. A bounded local `connect()` probe classifies the endpoint:
   - successful connection -> LIVE -> refuse startup and do not unlink;
   - `ECONNREFUSED` -> candidate orphan;
   - `ENOENT` -> endpoint disappeared -> continue;
   - timeout or any other error -> UNKNOWN -> refuse startup.
4. Before unlinking an `ECONNREFUSED` orphan, a second `lstat` must reproduce the original device, inode, uid, gid, Unix-socket type, non-symlink status, and `0600` mode.
5. Only then is the exact pathname removed using `unlinkSync`; recursive removal is not used.
6. The listener then follows the existing bind, harden-and-verify, ownership, credential, workspace, and authentication paths unchanged.

This does **not** weaken handling for regular files, symlinks, foreign ownership, wrong permissions, live endpoints, probe timeouts, or unknown errors. Those remain fail closed with `IDE_LISTENER_SOCKET_EXISTS`.

## Regression coverage

New listener-level regressions prove:

- a real child Node Unix listener killed with `SIGKILL` leaves an orphaned `0600` socket which the production listener safely reclaims and replaces with a new socket inode;
- a genuinely live owner-owned `0600` socket is refused and its inode remains present and unchanged.

New production-composition coverage proves:

- production startup recovers from an actual `SIGKILL`-style orphan on the exact provisioned runtime pathname;
- the credential file is byte-identical across recovery;
- the rebound production socket is a new `0600` Unix-socket inode.

All pre-existing stale regular-file and unsafe endpoint fail-closed tests remain present.

## Author-side validation receipts

Focused listener after final fixture repair:

- `tests/unit/ide-companion-listener.test.ts`: 37/37 PASS.

Listener + production composition after production regression:

- 2 files, 48/48 PASS.

Relevant P7/IDE authority and qualification matrix after final `unlinkSync` tightening:

- 26 files, 355/355 PASS.
- Includes listener, production composition, session store/recovery, B7/B9 coordinators/admission, runtime/auth/handshake/attestation, VS Code credential/connection/channel/activation/model seams, and P7 I2 qualification contracts.

Compiler/build:

- `npm run typecheck`: PASS in fresh owner-host process.
- `npm run build`: PASS in same fresh owner-host process.
- receipt job: `ohj_8faaea046b5e403feeab9823a2c99f18`
- receipt terminal marker: `COMPILER_AND_BUILD=PASS`.

Static diff hygiene:

- `git diff --check`: PASS.

## Validation attempts that are **not** relabeled PASS

A broad repository `npm test`/Vitest attempt was killed under the constrained projects-work process environment after early passing files. A second process-pool run ended with `ERR_IPC_CHANNEL_CLOSED`. A single-thread worker retry was invalid for this repository because worker threads cannot execute tests that call `process.umask()`, and that process was later killed. These are retained as environment/methodology failures, not converted into canonical full-suite PASS claims.

The accepted healthcheck-remediation review already recorded a similar distinction for its canonical full test command (`EXIT 137`) versus bounded fresh-process test evidence. This remediation preserves the same evidence rule.

## Live requalification status

The source remediation has **not yet** been promoted into canonical forward source and the SIGKILL live gate has **not yet** been rerun against an image built from the frozen remediation candidate.

Required next order:

1. freeze immutable candidate and hashes;
2. independent strictly read-only review;
3. only on independent PASS, fast-forward/integrate into forward source;
4. build exact integrated revision offline;
5. rerun live executor health + hard SIGKILL recovery + reconnect;
6. restore Remote-WSL Machine settings byte-for-byte to the preserved prequalification SHA-256 `c6fc408067761dfca2de20c9cbfcb9a8fbebbe4545007b038746ea8e004db2eb`;
7. clean only disposable qualification resources after evidence freeze;
8. reconcile project-control truth.

## Author verdict

`READY_FOR_INDEPENDENT_REVIEW`

No acceptance, merge, or final I2 qualification claim is made by the author.
