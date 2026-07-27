#!/usr/bin/env bash
# Quick protocol smoke test against a running gateway.
# Usage: BRIDGE_URL=http://127.0.0.1:8787 API_KEY=mcpb_... ./scripts/mcp-check.sh
set -euo pipefail
URL="${BRIDGE_URL:-http://127.0.0.1:8787}"
KEY="${API_KEY:?set API_KEY to a client key}"
H=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer ${KEY}")

echo "1) health:"; curl -sf "${URL}/healthz"; echo
echo "2) ready:";  curl -sf "${URL}/readyz"; echo
echo "3) unauth initialize (expect 401):"
curl -s -o /dev/null -w '   http=%{http_code}\n' -X POST "${URL}/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}'
echo "4) authed initialize:"
curl -s -X POST "${URL}/mcp" "${H[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}' | tail -1
echo "5) tools/list:"
curl -s -X POST "${URL}/mcp" "${H[@]}" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | grep -o '"name":"[a-z_]*"'
