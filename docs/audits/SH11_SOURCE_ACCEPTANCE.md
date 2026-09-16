# SH-11 Hostile Docker World — Source Acceptance

STATUS: `OWNER_AUTHORIZED_STRICT_SELF_AUDIT_PASS / SH11_SOURCE_ACCEPTED`

This receipt records source acceptance only. It is not an independent review,
not live Docker-daemon qualification, and not a claim that disclosure of the
executor-to-broker credential is harmless.

## Immutable implementation identity

- canonical base: `90bfc3a16540de0f42c809032ee0b01a49adb5e8`
- implementation tip: `a90f9a4b8a8fca6b09709ded35dffa6c129176d4`
- tree: `e394c2d9f0d199d63e341b6eb29a740857a1e660`
- cumulative path count: `15`
- cumulative patch SHA-256: `d2e962e2bf524bfea3c9f37d607c923341c93a5008a7c4666948055a245fabe9`
- cumulative content-manifest SHA-256: `4686781943593326aa8548bceacdc616012e1e96d88c622c68e00d952376b069`
- bounded post-create remediation: `a90f9a4b8a8fca6b09709ded35dffa6c129176d4`
- remediation patch SHA-256: `edb0c19f6c5d98354d7234b52d6eb6c9e45f0df238489d9e9e6ee939b4fe3a0c`
- remediation content-manifest SHA-256: `a30db67d74fbc177aec547417d65b1be1f3af7daad1979b739d0e1ab294be7cf`

## Findings closed

SH-11 hardened the broker against hostile named Docker requests from a
compromised executor holding the legitimate broker credential. The accepted
source now independently constrains:

- immutable image identity and managed ownership labels;
- privileged/device/namespace/port/runtime/capability/resource-limit fields;
- exact trusted host binds and role-specific managed-volume mount targets;
- same-job network attachment and provider-session cross-job binding;
- resource-specific capability exception for the applier only;
- managed helper post-create Docker exec to exact role contracts;
- managed archive reads/writes to each helper's mounted authority root;
- generic raw Docker forwarding remains unavailable.

The strict review found and remediated an additional post-create authority seam
after the first SH-11 implementation commit: managed helper exec/archive had
still been role-agnostic. The accepted tip includes that remediation and its
regressions.

## Immutable qualification

Against exact clean source `a90f9a4b8a8fca6b09709ded35dffa6c129176d4`:

- full unit: `142/142` files, `3015/3015` tests PASS;
- typecheck: PASS;
- build: PASS;
- authority invariants: `15/15` PASS across 10 Compose files / 7 Dockerfiles;
- SH-08 fixed security fuzz: PASS;
- SH-09 `security-chaos`: `2/2` files, `14/14` tests PASS;
- SH-10 `security-egress`: `1/1` file, `12/12` tests PASS;
- SH-11 `security-docker`: `2/2` files, `58/58` tests PASS;
- cumulative `git diff --check`: PASS;
- `/tmp/q` cleanup: PASS;
- cgroup `oom_kill`: unchanged `17 -> 17`.

The actual release receipt for `security-docker` is PASS and binds the exact
clean commit/tree above. Full release assurance remains `BLOCKED_ENVIRONMENT`,
with only the existing integration, E2E, SAST, secrets, SCA, config-scan,
image-scan, and provenance prerequisites unavailable.

## Authority / test-integrity audit

- Docker authority operation catalog remains exactly 22 named operations;
- no new raw Docker socket exposure or daemon method/path passthrough;
- no dependency, package-lock, Compose, Dockerfile, gateway or public MCP API
  authority expansion in the SH-11 delta;
- no `.skip`, `.todo`, or `.only` weakening introduced by SH-11;
- ordinary configured target terminal/filesystem operations remain separately
  governed and are not converted into managed-helper authority.

## Non-claims

The executor-to-broker token remains a shared product credential, not a per-job
cryptographic capability. A fully compromised executor can still exercise
legitimate named product operations available to the executor. SH-11 proves
fail-closed Docker request-shape, managed-object attachment and managed-helper
post-create containment within the broker-enforceable contract; it does not
claim the credential is safe to disclose.

Live Docker-daemon/owner-host qualification remains separate and must not be
represented as PASS until the required runtime authority is available.
