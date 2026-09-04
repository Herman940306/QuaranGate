# Compatibility

This document separates **the protocol/client ecosystem as it exists now** from **the exact compatibility QuaranGate has already proven**.

External products change. The statements below were rechecked against official documentation on **2026-09-04** and should be revalidated before a release that depends on a specific client UI or entitlement.

---

## Contents

- [Compatibility summary](#compatibility-summary)
- [MCP protocol baseline](#mcp-protocol-baseline)
- [QuaranGate MCP implementation boundary](#quarangate-mcp-implementation-boundary)
- [ChatGPT](#chatgpt)
- [Claude](#claude)
- [VS Code](#vs-code)
- [Kiro](#kiro)
- [Operating systems](#operating-systems)
- [What external compatibility does not prove](#what-external-compatibility-does-not-prove)
- [Official references](#official-references)

---

# Compatibility summary

| Surface | QuaranGate status | Current external ecosystem status |
|---|---|---|
| Remote MCP over HTTP | **Implemented and historically accepted** | MCP current specification revision is now `2026-07-28`; QuaranGate's accepted implementation is still based on the v1 TypeScript SDK / earlier protocol-era contract and requires an explicit migration gate before claiming the new revision |
| ChatGPT remote MCP | **Historically externally verified** | Current OpenAI full-MCP/write availability and UI are plan/workspace dependent; recheck before setup |
| Claude remote MCP | **Historically externally verified** | Claude supports remote MCP custom connectors, Streamable HTTP/SSE and OAuth/DCR on supported paid plans |
| VS Code remote MCP | **Supported design; client configuration documented** | VS Code supports remote HTTP MCP servers, headers and OAuth in `mcp.json` |
| Kiro remote MCP | **Supported design; client configuration documented** | Kiro supports remote HTTP MCP servers, headers and OAuth with user/workspace MCP config |
| Windows 11 + WSL2 | **Primary current development/qualification environment** | Supported by Docker Desktop/WSL workflow |
| Linux | **Architecture target** | Linux containers/native Docker are the core runtime model |
| macOS + Docker Desktop | **Design target, qualification pending** | Host-independent named-context/config design is intended to support it |

---

# MCP protocol baseline

The Model Context Protocol has advanced since QuaranGate's original implementation baseline.

## Current MCP specification

The current stable MCP specification is **`2026-07-28`**. It introduced major protocol changes including a stateless core, updated authorization behavior, extensions and updated Tier-1 SDK lines.

The MCP TypeScript SDK now has a stable **v2** line that implements the `2026-07-28` specification and replaces the older monolithic `@modelcontextprotocol/sdk` package with separate client/server packages.

## Why this matters to QuaranGate

QuaranGate was originally implemented and externally validated using the v1 TypeScript SDK line and the earlier `2025-11-25` protocol-era behavior.

That historical acceptance remains valid evidence for the implementation that was tested. It must **not** be silently rewritten into a claim that QuaranGate already implements every breaking change in `2026-07-28`.

The correct current statement is:

```text
QuaranGate remote MCP implementation: IMPLEMENTED / accepted on its current v1 SDK contract
Current MCP ecosystem revision:       2026-07-28
QuaranGate v2/spec migration:          requires explicit compatibility/implementation gate
```

### Why not upgrade inside documentation reconciliation?

A protocol/SDK migration can change wire behavior, OAuth/authentication semantics and client interoperability. Documentation should expose that gap; it should not perform or imply an unreviewed runtime upgrade.

---

# QuaranGate MCP implementation boundary

QuaranGate currently exposes a remote MCP endpoint at:

```text
/mcp
```

The accepted implementation includes:

- authenticated remote HTTP MCP access;
- typed tool schemas;
- structured tool results;
- per-principal authorization;
- OAuth façade for compatible browser clients;
- 23 current operational QuaranGate tools (14 direct target tools + 9 Agent Control Plane tools).

The exact protocol revision negotiated by a real client must be verified against the running build rather than inferred from this document.

---

# ChatGPT

## QuaranGate evidence

QuaranGate has historical real-client acceptance from ChatGPT against the remote MCP endpoint, including discovery, read/Git/terminal operations and a controlled write/read-back path. The tested ChatGPT client applied its own safety restriction to permanent delete before the request reached QuaranGate; QuaranGate did not disguise or route around that client-side decision.

That evidence remains a historical acceptance record.

## Current OpenAI product boundary — checked 2026-09-04

OpenAI's current help documentation describes **full MCP support including write/modify actions** through ChatGPT developer-mode/custom apps as a beta capability for **Business and Enterprise/Edu** workspaces. The same documentation states that Pro users can connect MCPs with read/fetch permissions in developer mode, while full MCP availability is more restricted.

OpenAI also states that ChatGPT connects to **remote MCP servers**, not directly to a normal local-only MCP listener; private/on-prem/local deployments require a supported remote/tunnel mechanism.

### Documentation consequence

QuaranGate must not claim:

> Every ChatGPT plan can connect with the full write-capable MCP surface.

Instead:

> QuaranGate provides a remote authenticated MCP endpoint. Whether a particular ChatGPT account/workspace can import and invoke its full tool surface depends on current OpenAI plan, admin and product policy.

The setup guide therefore tells operators to confirm current OpenAI availability before reproducing the historical browser test.

---

# Claude

## QuaranGate evidence

Claude remote browser/client integration was historically accepted against the real QuaranGate endpoint, including OAuth and controlled direct target operations.

## Current Anthropic boundary — checked 2026-09-04

Anthropic currently documents remote custom MCP connectors for Claude/Claude Desktop on **Pro, Max, Team and Enterprise** plans.

Current documented remote-server behavior includes:

- Streamable HTTP and SSE support (with SSE expected to deprecate over time);
- OAuth or authless remote servers;
- Dynamic Client Registration support;
- custom client ID/secret support for servers that do not use DCR;
- token expiry/refresh support;
- tools, prompts and resources.

QuaranGate's browser setup should prefer Streamable HTTP and its OAuth path rather than preserving old SSE examples simply because external clients may still support them.

---

# VS Code

## Current VS Code boundary — checked 2026-09-04

VS Code supports MCP server configuration in `mcp.json`, including:

- workspace `.vscode/mcp.json`;
- user-profile MCP configuration;
- remote HTTP server entries;
- authentication headers;
- OAuth configuration;
- trust/enable/disable controls;
- MCP server management through the Command Palette/UI.

For HTTP servers, VS Code currently tries the HTTP Stream transport and can fall back to SSE where needed.

VS Code documentation also now distinguishes configuration used by its Agent Host. Portable Agent Host configurations may use workspace `.mcp.json` or user `~/.copilot/mcp-config.json` rather than relying only on `.vscode/mcp.json`.

### QuaranGate recommendation

For the normal editor/workspace path, the committed QuaranGate example continues to use a remote HTTP MCP server entry with the QuaranGate endpoint and a secret input/environment mechanism rather than hard-coding the raw key.

Do not copy real API keys into a committed workspace file.

---

# Kiro

## Current Kiro boundary — checked 2026-09-04

Kiro supports remote MCP servers with a URL, optional headers and OAuth configuration.

Current Kiro documentation lists:

```text
workspace: .kiro/settings/mcp.json
user:      ~/.kiro/settings/mcp.json
```

Kiro supports:

- remote HTTPS MCP endpoints (HTTP allowed for localhost);
- headers;
- OAuth and OAuth scopes;
- Dynamic Client Registration when supported;
- `disabled` server state;
- `autoApprove` tool lists;
- `disabledTools` for removing tools from the agent's visible choice set.

### Security consequence

QuaranGate documentation should prefer **disabling tools a Kiro workflow does not need** over merely telling the model not to call them.

`autoApprove: ["*"]` is not an appropriate default for a high-authority QuaranGate client.

---

# Operating systems

## Windows 11 + WSL2 + Docker Desktop

This is the current primary development environment and the strongest platform evidence available for the project.

Repository/shell operations should be documented from the WSL Linux environment unless explicitly Windows-side.

## Linux

QuaranGate's runtime is Linux-container based and the architecture is naturally compatible with native Linux Docker deployments. A release should still run an explicit install/build/acceptance matrix rather than assuming the developer's WSL acceptance automatically proves every Linux distribution.

## macOS + Docker Desktop

The design target is compatibility through Docker Desktop/Linux containers and operator-supplied paths rather than Linux-host-specific hard-coded home paths.

macOS is **design-compatible, qualification required**.

Apple Silicon introduces an additional requirement: the base images and any native npm/model artifacts must be present/qualified for the target container architecture.

## Native Windows containers

Not a current product target.

---

# What external compatibility does not prove

A client successfully connecting to QuaranGate does not by itself prove:

- the client will invoke every destructive/write tool without its own confirmation/safety policy;
- a future client version preserves the same UI labels;
- the client's agent/extension host has no network egress;
- the client grants no additional authority through its own settings;
- the latest MCP protocol revision is implemented by the QuaranGate server;
- the current account/workspace plan is entitled to all MCP capabilities;
- an external ingress method is safe for every deployment.

Client behavior is one part of the end-to-end trust boundary and must be revalidated when it changes.

---

# Official references

Verified/rechecked 2026-09-04:

- Model Context Protocol — 2026-07-28 specification release: `https://blog.modelcontextprotocol.io/posts/2026-07-28/`
- MCP TypeScript SDK v2: `https://ts.sdk.modelcontextprotocol.io/v2/`
- OpenAI — Developer mode and MCP apps in ChatGPT: `https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta`
- Anthropic — Building Custom Connectors via Remote MCP Servers: `https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers`
- Anthropic — Getting Started with Custom Connectors Using Remote MCP: `https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp`
- VS Code — MCP configuration reference: `https://code.visualstudio.com/docs/agents/reference/mcp-configuration`
- VS Code — Add and manage MCP servers: `https://code.visualstudio.com/docs/agent-customization/mcp-servers`
- Kiro — MCP configuration: `https://kiro.dev/docs/mcp/configuration/`

Historical compatibility evidence belongs in `docs/TEST_RESULTS.md` and frozen audit records; this document describes the current external compatibility picture.
