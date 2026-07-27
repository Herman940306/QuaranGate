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

**Requires a public HTTPS URL.** The local `127.0.0.1` endpoint is not reachable from Anthropic's
cloud. See `docs/OPERATIONS.md` → *Remote ingress* (a gated operator action).

Once you have `https://your.domain/mcp`:

1. Claude → **Settings → Connectors → Add custom connector**.
2. URL: `https://your.domain/mcp`.
3. Auth, either:
   - **OAuth** (recommended, implemented): Claude discovers the OAuth metadata automatically; on
     connect it opens the bridge's `/authorize` page — paste the client's API key there to authorize.
   - **Request headers (beta):** add `Authorization: Bearer <key>` in Advanced settings.
4. Set `BRIDGE_PUBLIC_URL=https://your.domain` in `.env` so OAuth metadata advertises the right URLs,
   and rebuild the gateway.

Plans: Pro/Max/Team/Enterprise.

**Status:** server-side is ready and locally verified. Browser connection itself requires the public
URL + the in-product UI steps above — a genuine external/user action.

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
