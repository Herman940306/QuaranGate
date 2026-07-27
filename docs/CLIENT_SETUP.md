# Client setup

Generate a dedicated key per client first:

```bash
npm run gen-key -- vscode        # or claude-browser / chatgpt-browser / kiro
```

Copy the printed `keyHash:` into that client's entry in `config/clients.yaml`, then reload
(`docker compose restart gateway` or `curl -X POST` the executor `/reload` — see OPERATIONS).
Keep the printed key secret; it is shown once.

The endpoint is `http(s)://<host>/mcp`. Locally that is `http://127.0.0.1:8787/mcp`.

---

## VS Code

Use `config/vscode.mcp.example.json` as a template. Put it at `.vscode/mcp.json` in a workspace
(or via **MCP: Open User Configuration**):

```json
{
  "servers": {
    "mcp-ide-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer ${input:bridge_key}" }
    }
  },
  "inputs": [
    { "id": "bridge_key", "type": "promptString", "description": "mcp-ide-bridge API key", "password": true }
  ]
}
```

VS Code prompts for the key on first use and stores it in secret storage. Do not commit the key.

---

## Kiro

Use `config/kiro.mcp.example.json`. Put it at `~/.kiro/settings/mcp.json` (user) or
`.kiro/settings/mcp.json` (workspace):

```json
{
  "mcpServers": {
    "mcp-ide-bridge": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer ${BRIDGE_KEY}" },
      "disabled": false,
      "disabledTools": []
    }
  }
}
```

Export `BRIDGE_KEY` in Kiro's environment (or inline the key, but prefer the env reference). Kiro
connects over streamable-http. Use the path `/mcp` (avoid paths ending in `/message`).

> These instructions describe editing **your own** IDE config. This repo does not modify your real
> VS Code or Kiro settings.

---

## Claude browser (custom connector)

**Status: externally verified on 2026-07-27.** The gateway remains bound to `127.0.0.1:8787`; a
Tailscale Funnel publishes the HTTPS front door while the executor remains private. The verified
endpoint for this deployment is:

```text
https://wolf.taildc680e.ts.net/mcp
```

Setup used for the verified connection:

1. Set `BRIDGE_PUBLIC_URL=https://wolf.taildc680e.ts.net` in `.env` and recreate the gateway so OAuth
   metadata advertises the public issuer/resource.
2. Start the approved Tailscale Funnel to proxy public HTTPS to `http://127.0.0.1:8787`.
3. Claude → **Customize → Connectors → Add custom connector**.
4. URL: `https://wolf.taildc680e.ts.net/mcp`. Leave OAuth client ID/secret blank so Dynamic Client
   Registration is used.
5. On the bridge `/oauth/authorize` page, paste the dedicated `claude-browser` API key. The raw key
   is not stored in the repository.
6. Keep read-only tools on the least-friction policy desired by the operator; keep terminal/write/delete
   tools approval-gated unless broader automation has been explicitly accepted.

The live Claude round-trip verified `targets_list`, `fs_read`, `git_status`, `terminal_exec`,
`fs_write`, read-back, and `fs_delete` against the disposable `demo` target. Gateway audit records
attributed the calls to principal `claude-browser`; the principal remained limited to target `demo`.

For another deployment, replace the hostname above with its approved HTTPS ingress URL and keep
`BRIDGE_PUBLIC_URL` exactly aligned with that origin.

---

## ChatGPT browser (Developer Mode connector)

**Requires a public HTTPS URL + OAuth.**

1. Enable **Developer Mode** (Settings → Connectors → Advanced → Developer Mode; org admins enable
   per-workspace first).
2. **Create** a custom connector → URL `https://your.domain/mcp` → transport HTTP → Auth **OAuth**.
3. Complete the OAuth flow (paste the client API key on the bridge `/authorize` page).

Plans: Plus/Pro/Business/Enterprise/Edu (admin-gated).

**Status:** server-side ready and locally verified. The connector creation + OAuth approval are
external/user actions.
