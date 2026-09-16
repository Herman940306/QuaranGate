# SH-11 — Hostile Docker-World Qualification

## Scope

SH-11 treats Docker request bodies, managed-resource labels, mounted volume/network
identities, and daemon-visible object state as hostile at the executor→broker
boundary. The gate does not grant the executor any new operation and does not
expose the Docker socket outside the existing private broker.

## Findings remediated

1. `container.createManaged` previously validated only a subset of HostConfig.
   Hostile callers could express structured bind mounts, port publication,
   VolumesFrom, devices/device requests, host/custom namespaces, custom runtime/
   cgroup/DNS settings, anonymous volumes, Docker default mask overrides, and
   other daemon-level knobs not represented by QuaranGate's product policy.
2. Managed volume attachment was not independently bound to the creating
   container's job/operation/session identity. SH-11 now inspects every mounted
   volume from Docker state before container creation and rejects unauthorized
   resource-role, cross-job, cross-GitHub-operation, or provider-session binding.
3. `network.connectManaged` previously proved only that both objects were managed.
   It now requires the same job and permits second-network attachment only for
   the governed egress proxy role.
4. Docker ExecCreate bodies were forwarded without an independent broker policy.
   They are now restricted to the executor's bounded non-TTY stdout/stderr shape;
   privileged exec, stdin attachment, unknown fields, malformed users/paths and
   oversized argv/env are rejected.
5. The accepted applier requires exactly `DAC_OVERRIDE` and `FOWNER`; the old
   SH-02 broker denied every `CapAdd`. SH-11 reconciles this as a resource-specific
   exact exception while every other role remains capability-addition denied.
6. Kiro provider-session volumes legitimately survive across job IDs. Their
   existing principal/project/backend/profile SHA-256 provider binding is now
   propagated onto the runner identity and enforced at the broker for the one
   permitted cross-job session-volume mount.
7. Managed post-create exec/archive operations previously reused only the generic
   managed/trusted-container check. SH-11 now applies resource-role policy after
   inspecting Docker state: only git-helper/applier may exec, applier commands
   are exact source-controlled scripts with confined live-stat paths, and managed
   archive read/write paths are restricted to each helper's mounted root.

## Fail-closed invariants

- new managed resources use the current QuaranGate ownership namespace and
  canonical job/operation identifiers;
- managed containers use immutable local `sha256:` image IDs;
- raw/structured host bind mounts are denied except exact trusted project binds
  for the fixed stager/git/GitHub/applier roles and modes;
- managed volume targets/modes are role-specific and Docker-state ownership is
  independently inspected before create; ordinary cross-job attachment is denied,
  with only the provider-binding-verified Kiro session-resume exception;
- job networks have deterministic names/internal policy and cross-job network
  attachment is denied;
- managed helper exec/archive operations are constrained by resource role, exact
  command contract, and mounted path root; configured product targets retain their
  separately governed terminal/filesystem capability;
- generic Docker method/path forwarding remains absent;
- raw `/var/run/docker.sock` remains broker-only.

## Non-claims

SH-11 does not claim that the executor-to-broker credential is low privilege.
A fully compromised executor can still exercise legitimate named product
operations against configured targets/resources. The gate proves containment of
hostile Docker request shapes and object attachment within those named contracts;
it does not claim disclosure of the broker credential is harmless.

Live Docker-daemon qualification remains separate from source acceptance and must
not be represented as PASS where owner-host Docker authority is unavailable.

## Mutable-tree audit before freeze

The original pre-freeze matrix attached to `3c9f0ad` was superseded by the
post-create exec/archive remediation found during strict review. Current exact
counts are intentionally not claimed here until the widened audit below is rerun
on the remediated bytes. Final source acceptance requires complete mutable-tree
qualification, immutable requalification, and a source-bound `security-docker`
release receipt.
