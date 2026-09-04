# Test Results

This document records **point-in-time verification evidence**.

Older counts are preserved as historical truth. They are not silently replaced with the newest number. Read the current baseline first, then use the historical sections when investigating when a capability was introduced or accepted.

> [!IMPORTANT]
> Current accepted local source baseline: `18179696b3ef3ff2192805590027d2e1a43a43d4` (`build: add governed offline npm dependency bundle`). N1 is committed locally but was not pushed, deployed, or used to enable O1 as part of its acceptance. Older counts below remain historical evidence.

---

## Contents

- [Current verified baseline](#current-verified-baseline)
- [What the current baseline proves](#what-the-current-baseline-proves)
- [O1/Tini build-remediation evidence](#o1tini-build-remediation-evidence)
- [Historical milestone — initial bridge verification](#historical-milestone--initial-bridge-verification)
- [OAuth hardening](#oauth-hardening)
- [External Claude acceptance](#external-claude-acceptance)
- [External ChatGPT acceptance](#external-chatgpt-acceptance)
- [Agent Control Plane milestones](#agent-control-plane-milestones)
- [How to interpret test counts](#how-to-interpret-test-counts)
- [Reproduction boundaries](#reproduction-boundaries)

---

# Current verified baseline

Accepted N1 source checkpoint:

```text
HEAD:
18179696b3ef3ff2192805590027d2e1a43a43d4

commit:
build: add governed offline npm dependency bundle

parent:
6129d3d715e914e1f69d777fddd7a365bd902d44

TypeScript typecheck:
PASS

Unit test files:
44 / 44 PASS

Unit tests:
1693 / 1693 PASS

Source build:
PASS

No-cache Docker build with pre-provisioned inputs:
PASS

Docker build network:
none

Docker image pull during acceptance:
false

package-lock SHA-256:
31688b0a46cb5051e069ff049bbafd34752ace10dfb9dac3a60c9a3fef5258e5

Staging after commit:
empty

Known unrelated untracked:
.kiro/
```

N1 committed exactly ten paths:

```text
.dockerignore
.env.example
.gitignore
Dockerfile
compose.yaml
package.json
build/npm-dependencies.json
scripts/accept-npm-offline-build.mjs
scripts/npm-offline-bundle.mjs
tests/unit/npm-offline-bundle.test.ts
```

No production push, deployment, live-container restart/recreation or O1 enablement was part of the N1 acceptance/commit boundary.

---

# What the current baseline proves

The N1 baseline proves the source and build system can use a governed external npm dependency bundle without giving the real source build npm network authority.

Accepted N1 evidence includes:

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

It does **not** prove:

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

N1 adds deterministic npm-bundle tests and `scripts/accept-npm-offline-build.mjs`. The accepted reproduction procedure is documented in `docs/OPERATIONS.md`. Re-running the complete Docker acceptance still requires the approved external bundle and Docker access; do not substitute a networked install if the bundle is missing.
