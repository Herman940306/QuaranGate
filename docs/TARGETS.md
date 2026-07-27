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

## Using an existing project as a target (manual, opt-in)

You can add one of your existing containers as a **manual** target without modifying its stack —
just add a `targets:` entry referencing its Compose project/service (or container name) and its
workspace path, then authorize a client for it. The bridge never restarts, rebuilds, relabels, or
re-networks existing containers.
