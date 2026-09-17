# SH-13 — Same-User / IDE Adversarial Security Campaign

**Base:** `3e4821aea9dd5953e6433cffe850443ee29cfe65`
**Branch:** `security/sh13-same-user-ide-gpt`
**Scope:** source-level same-user / IDE authority attack campaign
**Acceptance mode:** owner-authorized strict self-audit after immutable freeze; not independent review
**Live IDE qualification:** not claimed by this source campaign

## Security question

SH-13 asks what QuaranGate can still prove when the IDE/client is hostile and a malicious local process may run under the same Unix identity as the legitimate extension host.

The answer is deliberately narrower than “the local IDE channel is secret.” POSIX `0700` directories and `0600` credential/socket modes separate Unix identities. They do **not** isolate two mutually hostile processes that already run with the same UID. A same-UID process can read user-owned credential bytes and can attempt to connect to or occupy user-owned socket paths. SH-13 therefore treats same-UID credential confidentiality and denial-of-service resistance as **outside the guarantees of this architecture** rather than overstating the filesystem mode boundary.

The product properties that remain enforceable are bounded authority and state binding: trusted enrollment configuration, exact IDE/runtime identity, current generation/session/controller leases, replay claims, workspace/worktree attestation, structured capability/payload binding, deterministic event sequencing, shared writer arbitration, secret rotation/revocation and fail-closed reconnect/restart recovery.

## Adversarial workstreams

### A. Socket, credential and replay

Examined and attacked:

- exact `0700` runtime-root / runtime-directory checks;
- exact `0600` credential and socket checks;
- socket pre-creation by regular file, live socket and orphan socket;
- symlink/type substitution rejection;
- stale orphan reclamation with pre/post device+inode checks;
- secret rotation and revocation;
- stale-secret replay;
- cross-runtime / cross-enrollment credential use;
- stale connection-generation replay;
- controller-lease replay;
- nonce replay and bounded replay persistence;
- restart and reconnect generation transitions.

Result: the replay/lifecycle controls remained fail closed. The same-UID process can read the credential, which is an explicit residual rather than a claimed isolation property.

### B. Workspace, malicious IDE and cross-IDE identity

Examined and attacked:

- IDE product / adapter identity mismatch;
- runtime-instance and IDE-instance substitution;
- workspace fingerprint substitution;
- canonical-path / file-URI mismatch;
- filesystem/environment identity drift;
- alternate Git worktree/common-dir identity;
- pinned Git revision drift;
- multi-root workspace rejection;
- VS Code/Cursor credential and command-channel separation;
- stale enrollment and runtime inventory drift.

Result: adapter-provided workspace evidence does not select logical project/worktree authority. The trusted enrollment contributes project/worktree identity, and physical evidence is verified against the enrolled fingerprint before an operation is admitted.

### C. Session, lease, reconnect and event lifecycle

Examined and attacked:

- stale generation;
- stale/released controller lease;
- reconnect overlap;
- stale challenge completion after a newer connection;
- disconnect during review or implementation;
- restart recovery;
- cancellation/completion races;
- duplicate and out-of-order event frames;
- duplicate terminal completion;
- stale-generation terminal completion;
- writer settlement after disconnect/timeout/restart;
- `agent_apply` versus IDE implementation writer contention;
- bounded response backpressure/sink failure.

Result: stale/duplicate control is rejected; ambiguous implementation mutation remains `UNCERTAIN` and holds writer authority rather than becoming safe success.

### D. Prompt, review/implementation and evidence/control confusion

Examined and attacked:

- review authorization substituted with implementation capability;
- implementation-looking fields smuggled into structured result frames;
- JSON/tool-looking text in model/IDE messages;
- embedded newline and Unicode bidi control-looking text;
- duplicate terminal result replay;
- operation/session/generation substitution;
- provider/model prose attempting to become authority;
- raw prompt/response persistence in Plane-B metadata.

Result: control remains structured. Hostile message text stays a bounded string payload and does not become a completion, writer lease, capability or operation transition. Plane-B event audit persists hashes/byte counts and event metadata rather than raw prompt/response text.

## Finding SH13-F1 — trusted IDE config integrity was not mode-checked

### Reproduction

A new adversarial regression created an otherwise valid, owner-owned `ide-sessions.yaml` with mode `0666` and started the production IDE composition.

**Pre-fix result:** startup succeeded. The SH-13 test intentionally failed because no `PRECONDITION_FAILED` was produced.

This is a real integrity defect. The config selects trusted enrollment identity, workspace fingerprint and allowed capabilities. An owner-owned file that remains group/world writable can be modified by another Unix identity on the host. A safe file is also insufficient if an unsafe non-sticky writable ancestor permits path replacement.

### Violated invariant

Authority-bearing trusted configuration must not be writable or replaceable by an untrusted Unix identity.

### Bounded remediation

`src/executor/ide/ideCompanionProduction.ts` now rejects:

- a trusted IDE session config with any group/world write bit (`mode & 0022`);
- a config reached through a non-directory or symlink ancestor;
- a config reached through a group/world-writable ancestor unless that ancestor has sticky protection.

Sticky shared ancestors such as `/tmp` remain valid. This is an integrity boundary against **other Unix identities**; it does not claim protection from the same UID, which remains capable of acting with that user's filesystem authority.

### Regression

`tests/unit/sh13-same-user-ide-adversarial.test.ts` proves both:

1. an owner-owned `0666` config is rejected before listener startup;
2. an owner-only config beneath a non-sticky `0777` ancestor is rejected.

## New SH-13 deterministic regressions

The dedicated SH-13 suite contains eight tests:

1. characterizes the residual same-UID ability to read the owner credential;
2. rejects group/world-writable authority config;
3. rejects replaceable config ancestry;
4. rejects implementation authorization substituted for a QuaranGate review command;
5. rejects authority-bearing extra fields in a structured implementation result;
6. rejects duplicate terminal-result replay;
7. proves JSON/newline/bidi hostile text remains data and cannot become control;
8. rejects stale-generation terminal completion.

These are additive. Existing B3-B9/I2/I3/SH-07/SH-08 suites continue to cover nonce replay, session/controller binding, workspace drift, socket lifecycle, cross-runtime identity, rotation/revocation, command/event ordering, writer arbitration, restart recovery and parser properties.

## Validation evidence

### Focused remediation

- SH-13 + production composition: **2/2 files, 20/20 tests PASS**
- typecheck: **PASS**

### Expanded IDE/auth attack matrix

- **29/29 files PASS**
- **343/343 tests PASS**
- VS Code command/credential/workspace paths included
- Cursor command/credential/workspace paths included
- SH-07 replay/generation binding included
- SH-08 IDE frame/identity properties included

### Whole repository

- unit: **145/145 files, 3040/3040 tests PASS**
- build: **PASS**
- `git diff --check`: **PASS**
- security invariants: **15/15 PASS** across 10 Compose files and 7 Dockerfiles
- security fuzz: **PASS**
  - seed: `1374718481`
  - targets: `15`
  - executions: `30067`
  - coverage ranges: `395`

## Residuals and non-claims

SH-13 does **not** claim:

- confidentiality of a `0600` credential from malicious code already running as the same UID;
- prevention of same-UID local denial of service against a user-owned Unix socket;
- process-binary/extension attestation;
- kernel-enforced isolation between same-user IDE extensions/processes;
- live VS Code/Cursor qualification that the current environment cannot provide;
- external penetration-test acceptance.

Those limitations are security boundaries, not missing claims to be papered over. A deployment requiring protection from mutually hostile processes under the same Unix account needs a stronger OS/process identity boundary (for example a distinct service identity and an authenticated broker/IPC design appropriate to that environment), which is an architecture decision rather than a prompt-level mitigation.

## Candidate disposition

The source campaign found one product-controlled integrity defect and remediated it with deterministic regression coverage. All currently available source-level SH-13 gates are green. The immutable candidate still requires exact freeze/hashes and `OWNER_AUTHORIZED_STRICT_SELF_AUDIT_PASS` before canonical integration.
