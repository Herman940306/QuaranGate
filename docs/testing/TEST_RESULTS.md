# Test Results

This document records **point-in-time verification evidence**.

Older counts are preserved as historical truth. They are not silently replaced with the newest number. Read the current baseline first, then use the historical sections when investigating when a capability was introduced or accepted.

> [!IMPORTANT]
> Current accepted local `main`: `09672d5150075741bb7fdc48f5e9cce1eba07cca`. Current deployed GitHub/MCP closeout candidate: `aef07f2c46ca53a55e1ee662f3b8cddc73f6857a`. That candidate passed typecheck, 50/50 unit files / 1878/1878 tests, 16/16 focused GitHub tests, and `git diff --check`. Older checkpoints below remain historical evidence and are not rewritten.

---

## Contents

- [Current verified deployed candidate](#current-verified-deployed-candidate)
- [What the current deployed candidate proves](#what-the-current-deployed-candidate-proves)
- [O1/Tini build-remediation evidence](#o1tini-build-remediation-evidence)
- [Historical milestone — initial bridge verification](#historical-milestone--initial-bridge-verification)
- [OAuth hardening](#oauth-hardening)
- [External Claude acceptance](#external-claude-acceptance)
- [External ChatGPT acceptance](#external-chatgpt-acceptance)
- [Agent Control Plane milestones](#agent-control-plane-milestones)
- [How to interpret test counts](#how-to-interpret-test-counts)
- [Reproduction boundaries](#reproduction-boundaries)

---

# Current verified deployed candidate

Current deployed side-quest checkpoint:

```text
LOCAL_MAIN:
09672d5150075741bb7fdc48f5e9cce1eba07cca

DEPLOYED_CANDIDATE:
aef07f2c46ca53a55e1ee662f3b8cddc73f6857a

TYPECHECK:
PASS

UNIT FILES:
50 / 50 PASS

UNIT TESTS:
1878 / 1878 PASS

FOCUSED GITHUB:
2 files / 16 tests / 0 failures

GIT DIFF CHECK:
PASS

LIVE github_checks:
PASS — Commit statuses only; checkRuns empty; no 422

LIVE github_repositories:
BLOCKED_HUMAN_GATE — JustAGameZA installation must use All repositories
```

Docker/local integration evidence ultimately cleared 62 supported tests. Five live-stack suites were **not collected** because the required `KEYS_ENV` scratchpad was absent; they are not counted as passes.

The candidate was deployed successfully and services were healthy. It was not promoted to local `main` because its path set intersects protected uncommitted owner work at `scripts/remote-owner-start.sh`. Remote `main` was not changed.

## Historical checkpoint — N1 governed offline npm build

The N1 checkpoint `18179696b3ef3ff2192805590027d2e1a43a43d4` remains accepted historical evidence: 44/44 unit files, 1693/1693 tests, source build PASS, and no-cache Docker build PASS with network `none`/no pull. N1 did not itself deploy or enable O1.

---

# What the current deployed candidate proves

The current deployed candidate proves:

- the GitHub App control plane can run behind the isolated broker/egress design;
- `github_checks` succeeds with Commit statuses only and does not require GitHub Checks permission;
- the hardened Node 24 Bookworm review/work images provide the required engineering toolchain while the review workspace remains read-only and without a Docker socket;
- typecheck, unit, focused GitHub and the supported Docker/local integration evidence listed above pass.

It does **not** prove side-quest closeout: `JustAGameZA` discovery remains human-gated by its Selected-repositories installation, source promotion is blocked by protected owner work, five `KEYS_ENV` live-stack suites were not collected, and the full post-remediation O1 live matrix was not rerun as part of this closeout.

Separately, historical N1 evidence includes:

- canonical `package-lock.json` remained byte-for-byte unchanged;
- lockfile v3 with 221 resolved entries and 220 unique artifact bodies;
- SHA-512 integrity coverage for 221/221 lock entries;
- dependency preparation limited to exact `registry.npmjs.org:443` lock URLs, with no redirects, npm credentials, Docker socket or project-source mount;
- deterministic bundle manifest SHA-256 `43eb077e7f23c23014882738508b624dd738cc0315d5ea8730392e15e6aec788`;
- full independent SHA-512 audit of all 220 tarballs;
- `npm ci --offline --ignore-scripts` PASS;
- TypeScript build PASS;
- no-cache Docker build PASS with build network `none` and `pull=false`;
- Tini 0.19.0 remained exact;
- dependency bundle/cache absent from the runtime image;
- live gateway/executor anchors unchanged by acceptance.

The N1 checkpoint did **not** prove:

- a completely empty machine can build with no pre-provisioned artifacts;
- cross-machine bit-for-bit base-image reproducibility, because the Dockerfile still uses `node:24-alpine` rather than an immutable digest in `FROM`;
- kernel-level egress filtering for the preparation container; its registry restriction is enforced by application URL policy;
- O1 container deployment is accepted or enabled;
- macOS production support;
- the newer MCP ecosystem has been migrated into the current implementation;
- full IDE Session Control production readiness.

A passing source/build suite should never be expanded into a claim it did not test.

---

# O1/Tini build-remediation evidence

## O1 final pre-rebase/source baseline

Before the Tini commit, the accepted O1 source baseline had already reached:

```text
43 test files
1671 / 1671 PASS
TypeScript PASS
```

The same count was re-established during C2 R3 after the local dependency environment was restored offline.

## Why earlier C2 R1 showed 1661/1671

The first C2 validation encountered:

```text
Cannot find module 'ollama'
```

and ten related test failures.

Independent reconciliation proved this was **LOCAL_DEPENDENCY_ENVIRONMENT_STALE**, not a source regression:

- `package.json` and `package-lock.json` required `ollama@0.6.3`;
- repository `node_modules` did not contain it;
- `npm ci --offline` succeeded from the local cache;
- the restored environment contained `ollama@0.6.3`;
- typecheck then passed;
- all 1671 tests passed.

This is a useful example of why QuaranGate's development process distinguishes:

```text
source failure
```

from:

```text
environment failure
```

rather than editing code until a broken environment stops complaining.

## Tini acceptance

Accepted Tini artifact:

```text
version:
0.19.0

SHA-256:
1358f1be32dc2a0dd8084dbda675c3b3dde8352b519b7b8a65573262551ad0fc

mode:
0755
```

Accepted Tini license SHA-256:

```text
e5f46bca81266bdd511cf08018d66866870531794569c04f9b45f50dd23c28b0
```

License evidence was corrected to use the exact Tini binary's built-in:

```text
tini -l
```

rather than scraping strings from the executable.

## Tini build claim boundary

Proven:

```text
TINI_BUILD_NETWORK_DEPENDENCY_REMOVED=YES
```

Not yet proven at that milestone:

```text
FULL_COLD_OFFLINE_BUILD_PROVEN=NO
```

Remaining issue at that point:

```text
npm ci inside the Docker build stage
```

N1 is the separate remediation for that remaining dependency path.

---

# Historical milestone — initial bridge verification

Executed 2026-07-27 on the original WSL2 development environment.

At that milestone the bridge had the original 14-tool direct target surface.

| Suite | Historical result |
|---|---|
| Unit | **20 / 20 PASS** |
| Live integration | **37 / 37 PASS** |
| MCP Inspector | 14 tools discovered and callable |
| Adversarial security checks | **12 / 12 expected** |

These counts are preserved because they prove the original bridge boundary before Agent Control Plane expansion.

## Initial unit coverage

The original unit suite included checks for:

- path traversal/absolute path rejection;
- workspace containment;
- API key hashing/verification;
- invalid/disabled client handling;
- independent principals;
- redaction;
- rate limiting.

## Initial live integration coverage

The initial integration suite exercised:

- authentication failures and success;
- OAuth flow;
- target discovery and decoy denial;
- authorization matrix;
- filesystem CRUD/patch/search;
- traversal and symlink escapes;
- terminal execution, timeout, output limits and cwd confinement;
- Git/process tools.

### Docker HTTP concurrency fix discovered during testing

A single undici connection allowed a long-running Docker exec stream to block the timeout-kill request behind it.

The Docker client was moved to a connection pool, after which the timeout path behaved within the expected bound.

Why this matters:

> Integration testing caught a control-path problem that unit tests alone could not demonstrate against real Docker exec behavior.

---

# OAuth hardening

The OAuth/browser path was hardened and re-tested after the initial bridge milestone.

Verified properties included:

- unsafe redirect rejection;
- exact registered redirect matching;
- mandatory MCP resource binding;
- PKCE failure rejection;
- single-use authorization codes;
- resource-bound access tokens;
- refresh client/resource binding;
- refresh rotation;
- replay rejection;
- non-root gateway data storage with restrictive permissions.

The historical suite remained green after the hardening.

---

# External Claude acceptance

Historical real-client verification against Claude proved the complete remote path rather than only a local HTTP script.

Accepted areas included:

```text
remote HTTPS MCP connection
OAuth discovery + authorization
Dynamic Client Registration
principal attribution
target discovery
filesystem read
Git inspection
terminal execution
controlled file write/read-back
permanent delete against disposable target
```

The controlled test artifact was removed and its absence independently confirmed.

The gateway/executor boundary remained unchanged after exposure.

Current Claude product/UI behavior should be rechecked before repeating the test because external clients evolve independently of QuaranGate.

---

# External ChatGPT acceptance

Historical real-client verification against ChatGPT proved:

```text
remote OAuth connection
tool discovery
structured schemas/results
target discovery
filesystem read
Git inspection
terminal execution
controlled write/read-back
principal attribution in gateway audit
```

During that test, the ChatGPT client blocked a permanent-delete invocation before it reached QuaranGate.

This was recorded as **client-side policy**, not a server failure.

QuaranGate kept the destructive annotation accurate and did not route around the client safety decision.

Current OpenAI MCP availability is plan/workspace dependent and should be revalidated before repeating the historical browser procedure.

---

# Agent Control Plane milestones

The Agent Control Plane deliberately grew through bounded gates.

Historical counts below remain evidence for the point where each architecture layer was introduced; they are not the current total.

| Gate | Key evidence boundary |
|---|---|
| A1 | Contracts/scopes/config/state-machine introduced; no real runtime agent |
| A2 | Durable SQLite job engine + deterministic fake backend; six agent tools activated |
| A3 | Runner sandbox, resource limits and Docker lifecycle foundation |
| A4 | Real Kiro ACP read-only backend |
| A5 | Kiro sandbox-write implementation profile |
| A6 | Machine diff, guarded apply/discard and retained-resource lifecycle |

The supplied Master PRD/audit series records exact per-gate counts and commit evidence. Those frozen audit records should be used when an investigation needs the exact number at that phase.

## A6 closeout history

A6 evidence included a `1398 / 1398` unit milestone during retained-resource lifecycle closeout plus dedicated policy/lifecycle suites. Later post-A6/O1 work increased the canonical suite to 43 files / 1671 tests.

Both statements are true because they describe different checkpoints.

---

# How to interpret test counts

A single number without a commit/state boundary is weak evidence.

The project therefore records:

```text
commit/source state
suite
count
runtime prerequisites
what was and was not rerun
```

Examples:

### Strong statement

> At `18179696`, `npm run typecheck` passed and 1693/1693 unit tests passed across 44 files, and the independently rechecked no-cache Docker build passed with source-build networking disabled.

### Weak statement

> All tests pass.

The second statement does not identify which tests, when, on which source or whether an integration/runtime suite was even available.

---

# Reproduction boundaries

The ordinary source validation commands remain:

```bash
npm run typecheck
npm test
```

Docker/live integration suites require the relevant target/runtime infrastructure, secrets and explicit authorization.

Do not automatically run credentialed provider tests, destructive apply tests or live deployment acceptance merely because they exist in the repository.

N1 adds deterministic npm-bundle tests and `scripts/accept-npm-offline-build.mjs`. The accepted reproduction procedure is documented in `docs/operations/OPERATIONS.md`. Re-running the complete Docker acceptance still requires the approved external bundle and Docker access; do not substitute a networked install if the bundle is missing.
