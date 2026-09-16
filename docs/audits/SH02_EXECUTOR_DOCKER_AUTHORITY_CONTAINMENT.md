# SH-02 — Executor Docker Authority Containment

Status: IN_PROGRESS / ARCHITECTURE FROZEN / IMPLEMENTATION NOT YET ACCEPTED

## Problem mechanically confirmed

The private executor currently bind-mounts `/var/run/docker.sock` read/write. Its network, authentication, non-root UID, read-only rootfs, dropped capabilities and narrow HTTP API reduce exposure, but they do not contain a successful executor compromise: possession of the raw Docker daemon socket is daemon-equivalent host authority.

This gate therefore MUST NOT be closed by documentation, `:ro` socket syntax, group changes, hiding the socket path, or an endpoint-only Docker socket proxy. Those measures do not enforce the product's intended authority against a compromised executor.

## Frozen containment architecture

Introduce a separate private `docker-authority` service as the only QuaranGate service that receives the host Docker socket. Remove the Docker socket and Docker group from `executor`. Executor Docker operations cross an authenticated private RPC boundary. The broker exposes named product operations rather than a generic Docker HTTP tunnel.

The broker must independently enforce the authority invariants for every operation; it must not trust the executor merely because the executor is authenticated. In particular:

1. no generic method/path/body forwarding primitive;
2. no image pull/build/import, plugin, swarm, secret, config, daemon, system, host, checkpoint, commit or arbitrary volume-driver operation;
3. container creation must independently reject privileged mode, capability additions, host PID/IPC, devices, Docker socket mounts and unapproved network modes;
4. host binds are denied by default and permitted only for the exact registered trusted-project/helper cases already required by QuaranGate policy, after canonical path/config validation;
5. managed runner/helper/proxy/volume/network mutation requires QuaranGate ownership labels and operation-specific validation;
6. existing target inspect/log/exec/start/stop/restart is restricted to containers resolved from trusted target configuration, never caller-supplied daemon identities;
7. destructive cleanup is ownership-scoped and idempotent; no daemon-wide prune/delete surface;
8. readiness proves the broker can reach Docker while executor proves broker reachability; executor itself must have no Docker socket;
9. broker has no published port, no edge network, no project source mount, no provider credential, no gateway credential and no job/evidence store;
10. regression tests must prove direct executor Docker access is absent and representative forbidden broker requests fail closed.

## Migration rule

Preserve the existing `src/executor/docker.ts` call-site contract initially to minimize unrelated behavioral churn, but replace its raw daemon transport with the named broker client. Move daemon-facing mechanics behind the broker only after each operation has an explicit broker contract and independent validation. Do not temporarily run both raw-socket and broker paths in production composition.

## Acceptance gates

- focused broker/client/policy unit tests PASS;
- all existing executor/agent Docker-policy tests PASS;
- repository unit/typecheck/build/diff-check PASS;
- Compose static proof: Docker socket exactly one consumer (`docker-authority`), executor has none, gateway/runners/work targets remain none; broker unpublished and private-only;
- source scan finds no raw Docker socket mount outside the broker and explicitly approved test/owner-host fixtures;
- no authority/network/credential broadening;
- exact-byte receipts and owner-authorized strict self-audit before canonical integration;
- live runtime proof is recorded separately and is not fabricated by source acceptance.

## Stop condition

Any required existing behavior that cannot be represented without restoring generic raw Docker authority to executor is a FAIL requiring redesign/remediation, not justification for weakening this gate.

## Implementation checkpoint 1 — broker policy foundation

A pure broker-side policy module now freezes the named operation vocabulary and rejects generic/raw daemon requests before any Docker I/O. Managed container creation independently requires QuaranGate ownership, `Privileged=false`, `CapDrop=ALL`, no capability additions/devices/host PID, no-new-privileges, an approved network mode, and trusted-root-only host binds; Docker socket binds are explicitly denied.

Validation at this checkpoint:

- focused SH-02 policy: 11/11 PASS;
- complete repository unit suite: 108 files / 2773 tests PASS;
- typecheck PASS;
- build PASS;
- diff-check PASS.

This checkpoint does **not** close SH-02. Executor still has the raw socket until the broker transport, operation handlers and Compose cutover are implemented and widened validation passes.

## Implementation checkpoint 2 — source containment cutover

The source cutover is now implemented. `docker-authority` is the sole production Compose consumer of the raw Docker socket. Executor no longer receives the socket or Docker group and its existing Docker call-site contract is transported through authenticated named broker operations. The broker independently revalidates managed ownership before destructive resource operations, restricts target-container authority to trusted manual registrations or explicit discovery opt-in, derives host-bind roots from mounted trusted configuration rather than request payload, bounds logs/archive inputs, and exposes no generic Docker method/path forwarding primitive.

Readiness semantics moved accordingly: executor readiness now proves authenticated broker reachability; the broker's own readiness proves Docker daemon reachability. The broker remains unpublished and internal-only and receives no job/data store or provider secret.

Source validation after cutover:

- focused SH-02/readiness/surface suite: 29/29 PASS;
- complete repository unit suite: 110 files / 2784 tests PASS;
- typecheck PASS;
- build PASS;
- diff-check PASS.

A worker-side `docker compose config` runtime/static expansion attempt could not execute because the governed `projects-work` worker image has no Docker CLI (`docker: not found`). This is classified `BLOCKED_ENVIRONMENT` for live/CLI Compose proof only; it is not converted into fabricated runtime evidence. YAML/source acceptance remains covered by the static Compose regression tests. Live runtime proof remains a separate owner-host qualification gate.
