# Client setup

This guide explains how to connect supported MCP clients to QuaranGate without hard-coding real credentials into the repository.

The exact client UI and entitlement can change independently of QuaranGate. The external-client notes below were rechecked against official documentation on **2026-09-04**.

---

## Contents

- [Before connecting a client](#before-connecting-a-client)
- [Generate one key per client](#generate-one-key-per-client)
- [Local vs remote endpoint](#local-vs-remote-endpoint)
- [VS Code](#vs-code)
- [Kiro](#kiro)
- [Claude](#claude)
- [ChatGPT](#chatgpt)
- [Client permission guidance](#client-permission-guidance)
- [Rotation and revocation](#rotation-and-revocation)
- [Troubleshooting](#troubleshooting)

---

# Before connecting a client

You need:

1. a running QuaranGate gateway;
2. `/readyz` returning success;
3. a client principal in `config/clients.yaml`;
4. a raw client API key stored by the client/operator, not committed to Git;
5. the corresponding SHA-256 `keyHash` stored in the client's QuaranGate principal record;
6. the required scopes and target/project grants for the work you actually want that client to perform.

Do **not** begin by granting every scope.

A connection test needs much less authority than an implementation workflow.

Recommended first grants are read-oriented:

```text
targets:read
files:read
git:read
process:read
```

Add terminal/write/agent scopes only after basic connection and target resolution are proven.

---

# Generate one key per client

Run from the QuaranGate repository terminal:

```bash
npm run gen-key -- vscode
```

or use another principal name such as:

```bash
npm run gen-key -- kiro
npm run gen-key -- claude-browser
npm run gen-key -- chatgpt-browser
```

The generator prints two different things:

```text
API key   -> store in the client; keep secret
keyHash   -> store in config/clients.yaml
```

The raw key is intentionally not recoverable from the stored hash.

### Why one key per client?

If VS Code, Kiro and a browser all share one key, you lose independent revocation and cannot cleanly attribute actions to the real caller.

Separate principals let you grant different authority and rotate one integration without breaking the others.

> [!IMPORTANT]
> If a raw client key is pasted into a chat transcript, terminal log, issue or other uncontrolled location, treat it as exposed and rotate it.

---

# Local vs remote endpoint

The MCP endpoint path is:

```text
/mcp
```

## Local client on the same machine/environment

Typical endpoint:

```text
http://127.0.0.1:8787/mcp
```

## Remote/browser client

A browser/cloud MCP client normally needs a reachable HTTPS endpoint.

QuaranGate itself binds loopback by default. External ingress is an explicit operator/infrastructure decision.

A historically verified deployment used Tailscale Funnel to publish HTTPS while leaving the gateway bound to `127.0.0.1`.

Do not copy that deployment hostname into another installation. Use the approved HTTPS origin for that deployment and set `BRIDGE_PUBLIC_URL` to the same public origin so OAuth metadata is consistent.

---

# VS Code

Current VS Code supports remote HTTP MCP servers in `mcp.json`, including authentication headers and OAuth configuration.

## Recommended workspace configuration

Use the committed QuaranGate VS Code example as the starting point.

A representative configuration is:

```json
{
  "servers": {
    "quarangate": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer ${input:quarangate_key}"
      }
    }
  },
  "inputs": [
    {
      "id": "quarangate_key",
      "type": "promptString",
      "description": "QuaranGate API key",
      "password": true
    }
  ]
}
```

Workspace location:

```text
.vscode/mcp.json
```

VS Code can also maintain user-profile MCP configuration through the **MCP: Open User Configuration** command.

## Setup steps

1. Generate a dedicated `vscode` QuaranGate key.
2. Add the `keyHash` to the VS Code principal in `config/clients.yaml`.
3. Give that principal only the scopes/targets required for the intended lane.
4. Save `.vscode/mcp.json` or the user MCP configuration.
5. Start/reload the server through VS Code's MCP management UI if required.
6. Provide the raw API key through the secret input when prompted.
7. First test `targets_list` / a read operation before enabling write or terminal authority.

## Agent Host note

Recent VS Code versions distinguish normal editor MCP configuration from portable Agent Host configuration. Current VS Code documentation notes that portable Agent Host setups may use workspace `.mcp.json` or user `~/.copilot/mcp-config.json`.

QuaranGate does not need to force one configuration style for every VS Code workflow. Use the configuration location appropriate to the VS Code execution surface you are actually qualifying.

## Security note

VS Code has its own MCP trust/tool-selection controls. Do not treat a successful server connection as permission to auto-approve every QuaranGate write/destructive tool.

---

# Kiro

Current Kiro supports remote MCP servers through workspace or user JSON configuration.

Locations documented by Kiro:

```text
workspace: .kiro/settings/mcp.json
user:      ~/.kiro/settings/mcp.json
```

Representative configuration:

```json
{
  "mcpServers": {
    "quarangate": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer ${QUARANGATE_CLIENT_KEY}"
      },
      "disabled": false,
      "autoApprove": [],
      "disabledTools": []
    }
  }
}
```

Use an environment/secret mechanism supported by your Kiro environment rather than committing the raw key.

## Setup steps

1. Generate a dedicated `kiro` QuaranGate client key.
2. Put only the `keyHash` into QuaranGate client configuration.
3. Expose the raw key to Kiro through the selected secret/environment mechanism.
4. Configure the QuaranGate `/mcp` URL.
5. Save the config; current Kiro reconnects MCP servers when configuration changes.
6. Confirm the server appears connected.
7. Keep `autoApprove` narrow.
8. Use `disabledTools` when a Kiro workflow should not even see dangerous QuaranGate operations.

## Why `disabledTools` matters

Removing a capability from the agent's available tool set is stronger than leaving it visible and relying on the prompt to say:

> Do not use this tool.

For high-risk workflows, capability reduction should be preferred where the client supports it.

---

# Claude

QuaranGate has historical real-client acceptance with Claude remote MCP.

Current Anthropic documentation (rechecked 2026-09-04) says remote custom connectors are available on supported **Pro, Max, Team and Enterprise** plans and support Streamable HTTP/SSE plus OAuth/DCR.

## Remote connector setup

1. Ensure QuaranGate has an approved HTTPS ingress URL.
2. Set `BRIDGE_PUBLIC_URL` to the matching public origin and restart/recreate according to the normal operations procedure if required.
3. Generate a dedicated `claude-browser` key and store only its hash in QuaranGate configuration.
4. In Claude/Claude Desktop, open **Settings → Connectors**.
5. Add a custom connector using:

   ```text
   https://<your-approved-host>/mcp
   ```

6. Prefer OAuth/DCR where using QuaranGate's browser authorization path.
7. When the QuaranGate authorization page asks for the client API key, provide the dedicated raw `claude-browser` key.
8. Start with read-oriented tools and confirm the target identity before enabling broader actions.

The historical QuaranGate acceptance exercised discovery, filesystem read, Git, terminal, write/read-back and delete against a disposable target. That is evidence for the tested deployment; it is not permission to assume every future Claude version applies identical action-confirmation policy.

---

# ChatGPT

QuaranGate has historical real-client acceptance with ChatGPT remote MCP.

OpenAI product availability has changed since the original browser acceptance, so this setup must distinguish **QuaranGate compatibility** from **current ChatGPT account/workspace entitlement**.

## Current OpenAI product boundary — rechecked 2026-09-04

OpenAI currently documents full MCP support, including write/modify actions, through ChatGPT developer-mode/custom apps as a beta feature for **Business and Enterprise/Edu** workspaces. OpenAI's current help documentation states that Pro users can connect MCPs with read/fetch permissions in developer mode, while full MCP is more restricted.

This can change. Check OpenAI's current product documentation before reproducing a write-capable browser acceptance test.

## Remote setup pattern

1. Ensure the QuaranGate endpoint is reachable through the supported remote method for your ChatGPT product/workspace.
2. Set `BRIDGE_PUBLIC_URL` to the exact public OAuth origin.
3. Generate a dedicated `chatgpt-browser` QuaranGate key.
4. Store its SHA-256 `keyHash` in `config/clients.yaml`.
5. In the ChatGPT app/custom-MCP setup available to your workspace, create the QuaranGate integration with:

   ```text
   https://<your-approved-host>/mcp
   ```

6. Select OAuth where using the QuaranGate browser authorization flow.
7. Complete the QuaranGate authorization page with the dedicated raw `chatgpt-browser` key.
8. Scan/refresh tools as required by the current ChatGPT UI.
9. Prove target discovery and read behavior before testing write/destructive actions.

## Client-side safety behavior

In the historical QuaranGate acceptance, ChatGPT successfully exercised controlled write/read-back, but blocked one permanent-delete invocation in the ChatGPT client before the request reached the gateway.

QuaranGate intentionally did **not** weaken the MCP destructive annotation or use `terminal_exec` as a workaround.

### Why preserve that behavior?

Client safety policy and server authorization are independent layers. The server should not disguise a destructive action merely to make another client invoke it.

---

# Client permission guidance

Start narrow.

## Read-only review client

Typical direct scopes:

```text
targets:read
files:read
git:read
process:read
```

## Controlled terminal client

Add:

```text
terminal:exec
```

only when the target/workflow requires it.

## Direct file writer

Add:

```text
files:write
```

and grant `files:delete` only when permanent deletion is genuinely required.

## Agent review/dispatch client

Agent scopes and grants are separate from target scopes.

Examples:

```text
agents:read
agents:dispatch
```

plus explicit project/backend/profile grants.

## Apply authority

Grant:

```text
agents:apply
```

only to principals that are allowed to promote reviewed evidence into real projects.

A client that can dispatch a sandbox implementation does not automatically need apply authority.

---

# Rotation and revocation

## Rotate a static client key

1. generate a new key for the same intended principal/client identity;
2. update the stored `keyHash` in `config/clients.yaml`;
3. reload/restart the gateway according to the current operations procedure;
4. update the client with the new raw key;
5. prove the old raw key is rejected;
6. prove the new key resolves to the intended principal.

## Disable a client

Disable/revoke the principal using the repository's supported credential/config workflow.

## OAuth clients

OAuth bearer/refresh-token behavior maps to the underlying principal. Rotating/disabling the client identity should be followed by a real authentication test rather than assuming cached browser state has already disappeared.

---

# Troubleshooting

## Server appears configured but tools are unavailable

Check:

```text
/healthz
/readyz
client key/principal enabled
required scope
required target grant
required project/backend/profile grant
client-side tool enabled/disabled state
```

## `401` / authentication failure

Common causes:

- wrong raw API key;
- stale client key after rotation;
- disabled principal;
- expired/invalid OAuth bearer;
- OAuth public origin mismatch.

## Target not visible

Check:

- target configuration/opt-in discovery;
- exact target ID;
- unique running Compose service/container resolution;
- client's target allowlist.

Discovery and authorization must both pass.

## Agent tool returns unavailable

The Agent Control Plane is optional/fail-closed when its trusted configuration is absent or disabled.

Check `config/agents.yaml`, backend enablement and the principal's project/backend/profile grants.

## Browser client cannot connect to `127.0.0.1`

A cloud/browser MCP client cannot normally reach your machine's loopback address directly. Use the supported remote/private ingress mechanism for that product and deployment rather than exposing the executor or rebinding QuaranGate indiscriminately.

## UI instructions no longer match

Client products evolve quickly. Check the current official client documentation referenced in [Compatibility](COMPATIBILITY.md), then update this guide in a bounded documentation change rather than guessing from an old screenshot.
