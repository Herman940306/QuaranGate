# QuaranGate Remote Owner Workstation Orchestration

Status: **IMPLEMENTATION CANDIDATE — LIVE DEPLOYMENT / REMOTE ACCEPTANCE PENDING**

This document records the owner-approved remote workstation operating model: when the home workstation is powered on and its normal Windows/WSL/Docker session is available, the owner may continue development from an authenticated remote QuaranGate client without giving ordinary work targets raw Docker administration.

## Owner-approved intent

- expose the owner's projects root through one broad read/write target;
- preserve normal filesystem/Git permissions under the ordinary uid/gid rather than privileged bypass;
- permit remote orchestration of already-registered project containers;
- keep the Docker socket out of project work targets;
- keep Docker authority private to the QuaranGate executor;
- allow bounded container inspect/log/lifecycle operations by logical target id only;
- preserve loopback-only gateway publication with approved HTTPS ingress in front;
- recover the local stack automatically after the normal Windows owner logon/Docker startup path;
- fail closed rather than pull/build/create/reconfigure infrastructure during unattended recovery.

## Authority split

```text
remote owner principal
       |
       v
authenticated QuaranGate gateway
       |
       v
private executor ------------------> Docker socket
       |                               (executor only)
       |
       +--> projects-work target --> /home/<owner>/projects RW
       |                         X--> no Docker socket
       |
       +--> other manual targets
```

`projects-work` is intentionally broad filesystem authority. Its configured workspace is `/workspace`, backed by the explicit host `PROJECTS_ROOT`. It does not grant access to the rest of the host home directory unless that path is itself beneath the approved projects root.

## New direct capabilities

The implementation adds four direct tools:

| Tool | Scope | Mutation | Boundary |
|---|---|---:|---|
| `target_logs` | `targets:logs` | no | bounded stdout/stderr; manual target only |
| `target_start` | `targets:control` | yes | existing manual target container only |
| `target_stop` | `targets:control` | yes | existing manual target container only |
| `target_restart` | `targets:control` | yes | running existing manual target only |

These tools never accept raw Docker identifiers or arbitrary Docker configuration. The request schema cannot express images, host paths, mounts, networks, ports, devices, capabilities, privileged mode, container creation/removal, or Docker daemon passthrough.

Discovery remains identity-only. A discovery-only target is explicitly rejected for lifecycle/log control; mutable infrastructure authority requires a manual target registration.

## Scope separation

The direct target scopes are intentionally independent:

```text
targets:read       metadata/list/inspect
targets:logs       bounded container logs
targets:control    start/stop/restart existing manual targets
files:*            workspace filesystem authority
terminal:exec      target-confined shell authority
git:read           direct Git read tools
process:read       target process inspection
```

A principal needs both a matching target allowlist entry and the operation-specific scope.

## Persistent umbrella target

`projects-work-target/compose.yaml` is the durable definition. It requires `PROJECTS_ROOT` at Compose evaluation time and mounts exactly:

```text
${PROJECTS_ROOT}:/workspace:rw
```

Hard boundaries retained:

```text
Docker socket:        absent
privileged:           false / absent
capabilities added:   none
capabilities dropped: ALL
no-new-privileges:    true
uid/gid:              1000:1000
/tmp:                  tmpfs
restart policy:        unless-stopped
```

## Recovery path

`scripts/remote-owner-start.sh` is the WSL recovery entrypoint. It waits for the already-installed Docker Engine, starts only already-local images with `--no-build --pull never`, starts the normal QuaranGate compose project and `projects-work`, waits for gateway health, and then runs the health proof.

`scripts/windows/Install-QuaranGateRemoteOwnerAutostart.ps1` registers this entrypoint at owner logon. This is deliberately not represented as a pre-login/cold-boot guarantee: Docker Desktop normally belongs to the interactive user session and must itself be configured to start with Windows/user logon.

## Ingress boundary

QuaranGate remains loopback-bound on the host. Remote browser access is supplied by the already-approved external HTTPS ingress layer. The recovery/health scripts may inspect Tailscale Funnel status read-only, but they do not mutate Funnel, firewall, tailnet policy, or public exposure.

## Security proofs required before closeout

Source/static gates:

- `targets:control` and `targets:logs` must be deny-by-default scopes;
- lifecycle resolution must require one exact manually configured target;
- discovery-only lifecycle requests must fail closed;
- restart of a stopped target must refuse rather than silently start it;
- requested final running/stopped state must be independently re-inspected;
- work-target compose must contain no Docker socket;
- recovery must perform no pull/build.

Live gates after deployment:

1. `projects-work` visible/running with the approved projects root RW;
2. disposable read/write/delete under a project succeeds;
3. target-confined terminal execution succeeds;
4. target metadata/health inspection succeeds;
5. bounded target logs succeed only for a principal with `targets:logs`;
6. a disposable/explicitly approved target restart succeeds and returns healthy/running;
7. principal without `targets:control` is denied lifecycle mutation;
8. discovery-only target control is denied;
9. gateway remains loopback-only;
10. executor remains unpublished and executor-only Docker socket ownership is preserved;
11. remote HTTPS ChatGPT path remains functional after deployment;
12. no arbitrary container creation/mount/privileged-control public tool exists.

## Non-goals

This phase does **not** grant a work target raw Docker CLI/socket access, arbitrary host shell access, arbitrary host mounts, privileged container creation, firewall/Tailscale administration, or automatic QuaranGate self-upgrade/recreate authority.

QuaranGate self-deployment remains a distinct infrastructure operation because an executor cannot safely replace its own trust boundary through the same request it is serving.

## Changelog

- 2026-09-06 — owner approved broad `~/projects` read/write access for remote continuation.
- 2026-09-06 — owner clarified that Docker need is bounded container control, not raw Docker-host administration.
- 2026-09-06 — implementation candidate adds umbrella target, dedicated lifecycle/log scopes, four bounded target tools, recovery/health/acceptance scripts, and documentation/tests. Live deployment and remote acceptance remain pending until host-side build/deploy gates pass.
