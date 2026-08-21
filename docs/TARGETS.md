# Targets

A **target** is a Docker container the bridge is allowed to automate, plus the absolute
in-container **workspace** path that filesystem/terminal tools are confined to.

Two independent gates must both pass for a client to use a target:
1. The target exists in the bridge (manual config **or** opt-in discovery).
2. The client's `targets` list in `config/clients.yaml` includes that target id (or `"*"`).

**Discovery identifies; it never authorizes.**

## Manual targets (recommended, stable)

`config/bridge.yaml`:

```yaml
targets:
  - id: demo                              # stable id used by clients + tools
    composeProject: myproject             # com.docker.compose.project label
    composeService: dev                   # com.docker.compose.service label
    workspace: /workspace                 # absolute path INSIDE the container
```

Identity is the **Compose project + service**, resolved to a live container id at request time.
This survives `docker compose up --force-recreate` (verified). Alternatively pin a fixed name:

```yaml
  - id: legacy
    containerName: my-existing-container
    workspace: /srv/app
```

You do **not** need to edit the target project's Compose files to use manual targets.

## Opt-in discovery (no manual config)

Set on the target container (labels), then it appears automatically:

```yaml
labels:
  mcp.bridge.enabled: "true"
  mcp.bridge.workspace: "/workspace"      # required, absolute
  mcp.bridge.name: "demo"                 # optional display id
```

Disable discovery globally with `discovery.enabled: false` in `config/bridge.yaml`. Manual config
always wins over a discovered target with the same id (no silent conflicts).

## Permissions

Authorization is per client in `config/clients.yaml`:

```yaml
clients:
  - id: vscode
    targets: ["demo"]        # explicit ids, OR ["*"] = all CONFIGURED targets (never all containers)
    scopes: [targets:read, files:read, files:write, terminal:exec, git:read]
```

Scopes: `targets:read` `files:read` `files:write` `files:delete` `terminal:exec` `git:read`
`process:read`.

## Fail-closed behaviour

| Situation | Result |
|---|---|
| Target not in config/discovery | `UNKNOWN_TARGET` |
| Target not in the client's `targets` | `FORBIDDEN_TARGET` |
| ≥2 running containers match one target | `AMBIGUOUS_TARGET` |
| Target container stopped | `TARGET_OFFLINE` |
| Target has no `/bin/sh` / workspace missing | `TARGET_UNSUPPORTED` |
| Missing scope for the tool | `FORBIDDEN_SCOPE` |

## Minimum target requirements

`/bin/sh` and `readlink -f` or `realpath` (GNU coreutils **or** busybox qualify). `git` only for the
git tools. Distroless/scratch containers are unsupported.

## Target lanes shipped in this repository

The repo ships four target definitions demonstrating three distinct authority levels. Each is an
independent Compose stack; none of them is started by `compose.yaml`.

| Definition | Source mount | Role |
|---|---|---|
| `test-target/` | none (disposable container) | Integration fixture. Service `dev` is the authorized `demo` target; service `decoy` carries no bridge labels and must never be reachable — it is an active negative test. |
| `review-target/` | this repo, `:ro` | Read-only review of the bridge's own source. `git` and `python3` are baked into the image at build time (no runtime `apk`); `node_modules` and `dist` are writable named volumes so tooling can run. |
| `assistant-environment-review-target/` | a separate project, `:ro` | Read-only review lane for another project. `git`, `bash`, `python3` baked in. |
| `assistant-environment-work-target/` | a separate project, `:rw`, with `.git` re-mounted `:ro` | Constrained **write** lane. |

### Read-only review lanes

The source is mounted `:ro`, so no tool — including `terminal_exec` — can modify it. Writable
scratch space is provided separately as tmpfs or named volumes. This is the right lane for code
review, search, and analysis.

### The constrained write lane

`assistant-environment-work-target` is deliberately narrower than "writable":

```text
/workspace       project source   READ/WRITE
/workspace/.git  Git metadata     READ-ONLY   (nested bind overrides the parent)
```

The read-only `.git` overlay is the hard technical boundary: the agent may edit source, run
tests, and read Git history, but cannot stage, commit, branch, tag, stash, rebase, merge, or
push. Repository history cannot be rewritten from inside the target.

The container runs as `user: "1000:1000"` with `cap_drop: ALL`. Because there is no
`CAP_DAC_OVERRIDE`, write access comes from ordinary file permissions rather than from
privilege, and files created in the workspace stay owned by the host user.

These definitions reference absolute host paths and are environment-specific — treat them as
patterns to copy, not as portable configuration.

## Using an existing project as a target (manual, opt-in)

You can add one of your existing containers as a **manual** target without modifying its stack —
just add a `targets:` entry referencing its Compose project/service (or container name) and its
workspace path, then authorize a client for it. The bridge never restarts, rebuilds, relabels, or
re-networks existing containers.
