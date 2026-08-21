# Client compatibility (verified against current official docs)

> This document records compatibility verification as of 2026-07-27/2026-07-28.
> It is a point-in-time verification record, not the authoritative current
> feature/status register. Tool counts and phase status cited below (e.g. "14
> tools") reflect what was live at the time each verification ran. See
> README.md, MCP_IDE_BRIDGE_MASTER_PRD.md, and docs/AGENT_CONTROL_PLANE.md for
> current tool counts and phase status.

All facts checked **2026-07-27**. Materially-architectural facts carry a source URL.

## Model Context Protocol

| Fact | Source | Checked |
|---|---|---|
| Current stable spec revision **2025-11-25**; a `2026-07-28` revision finalizes imminently (stateless core) | https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ ; https://modelcontextprotocol.io/specification | 2026-07-27 |
| Remote transport = **Streamable HTTP** (single `/mcp` endpoint, POST + optional GET SSE) | https://modelcontextprotocol.io/specification (transports) | 2026-07-27 |
| Legacy **HTTP+SSE transport is deprecated** (superseded by Streamable HTTP since 2025-03-26; formally "Deprecated" in the 2026-07-28 RC) | https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ | 2026-07-27 |
| Remote auth = **OAuth 2.1** (PKCE S256, exact redirect URIs, DCR/CIMD); servers host Protected Resource Metadata | MCP authorization spec | 2026-07-27 |
| Tool annotations (`readOnlyHint`/`destructiveHint`/`openWorldHint`) supported | MCP tools spec | 2026-07-27 |
| Official TypeScript SDK `@modelcontextprotocol/sdk` latest **1.30.0** | npm registry | 2026-07-27 |

**Decision:** implement Streamable HTTP with the official SDK 1.30.0; advertise protocol
`2025-11-25`; expose tool annotations; provide OAuth 2.1 metadata + PKCE for browser clients.

## Claude browser (custom connectors / remote MCP)

| Fact | Source | Checked |
|---|---|---|
| Claude connects to the MCP server **from Anthropic's cloud** → server must be reachable over public internet (allowlist Anthropic IPs) | https://support.claude.com/en/articles/11175166 | 2026-07-27 |
| Supports **authless and OAuth** servers; OAuth callback `https://claude.ai/api/mcp/auth_callback` (also allowlist `claude.com`); supports token expiry/refresh | https://support.claude.com/en/articles/11503834 | 2026-07-27 |
| Supports **SSE and Streamable HTTP**; SSE may be deprecated soon | https://support.claude.com/en/articles/11503834 | 2026-07-27 |
| **Beta:** static request-header auth (API key/bearer) configurable in the connector dialog | https://claude.com/docs/connectors/custom/remote-mcp | 2026-07-27 |
| Availability: Pro, Max, Team, Enterprise (Desktop connectors only via Settings > Connectors) | https://support.claude.com/en/articles/11175166 | 2026-07-27 |

**Decision:** provide OAuth 2.1 façade **and** accept a static Bearer/`X-API-Key`; both map to the
same per-client principal. **External verification completed 2026-07-27** using the OAuth path over
Tailscale Funnel HTTPS. The gateway stayed loopback-bound and the executor stayed unpublished.

## ChatGPT browser (developer-mode MCP plugins/apps)

| Fact | Source | Checked |
|---|---|---|
| Requires **HTTPS endpoint + OAuth** (or "no auth" for dev/testing, which we reject) | https://developers.openai.com/api/docs/mcp ; https://help.openai.com/en/articles/12584461 | 2026-07-27 |
| Supports **SSE and Streamable HTTP**; use `/mcp` for HTTP transport | https://developers.openai.com/api/docs/mcp | 2026-07-27 |
| Developer Mode toggled in Settings; org admins enable per-workspace; write actions prompt for confirmation | https://help.openai.com/en/articles/12584461 | 2026-07-27 |
| Product/account availability and permissions are time-sensitive; current official guidance says full MCP/write support is rolling out for Business and Enterprise/Edu, with narrower Pro support | https://help.openai.com/en/articles/12584461 | 2026-07-28 |

**Decision:** OAuth 2.1 façade at `/mcp`. **External verification completed 2026-07-28** over the
same approved Tailscale Funnel used for Claude. ChatGPT completed OAuth/DCR, imported the 14 tools,
and successfully invoked discovery, read, Git, terminal, and write/read-back operations as principal
`chatgpt-browser`. `fs_delete` was visible as WRITE / DESTRUCTIVE but was blocked client-side before
reaching the gateway; retain its destructive classification.

## VS Code

| Fact | Source | Checked |
|---|---|---|
| MCP config in `.vscode/mcp.json` (workspace) or user `mcp.json`; `"type":"http"`, `url`, `headers` | https://code.visualstudio.com/docs/copilot/customization/mcp-servers | 2026-07-27 |
| Secrets via `inputs` (promptString/password) — do not hardcode | same | 2026-07-27 |

**Decision:** ship `config/vscode.mcp.example.json` (`type: http`, Authorization header via
`${input:bridge_key}`). Works against the **local** `http://127.0.0.1:8787/mcp`.

## Kiro

| Fact | Source | Checked |
|---|---|---|
| Config `~/.kiro/settings/mcp.json` (user) or `.kiro/settings/mcp.json` (workspace); remote server = `url` + `headers`, streamable-http; `disabled`, `disabledTools` supported; env refs `${VAR}` | https://kiro.dev/docs/mcp/configuration/ | 2026-07-27 |
| Known bug: remote URLs ending in `/message` mis-detected as SSE (we use `/mcp`) | https://github.com/kirodotdev/Kiro/issues/8313 | 2026-07-27 |

**Decision:** ship `config/kiro.mcp.example.json` (`url` + Authorization header via `${BRIDGE_KEY}`).
Works against the **local** endpoint.

## Summary

- **VS Code and Kiro** work fully against the local loopback endpoint.
- **Claude browser** is externally verified over the approved Tailscale Funnel ingress, including
  OAuth and real read/execute/write/delete tool calls against the disposable `demo` target.
- **ChatGPT browser** is externally verified over the approved Tailscale Funnel ingress, including
  OAuth/DCR, tool discovery, structured schemas, read/Git/terminal/write/read-back calls, and audit
  attribution to `chatgpt-browser`. Permanent `fs_delete` remained available server-side but the real
  ChatGPT client blocked that invocation before it reached the gateway.
- ChatGPT product/account requirements and safety policy remain time-sensitive; re-check current
  OpenAI documentation before another deployment.
