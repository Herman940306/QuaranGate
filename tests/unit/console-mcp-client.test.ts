import { describe, expect, it, vi } from 'vitest';
import { McpClient, McpClientError, parseTransportPayload, structuredFromResult } from '../../console/mcp-client.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('QuaranGate Console MCP client', () => {
  it('invokes the selected fetch implementation with the global receiver', async () => {
    const fetchImpl = vi.fn(async function (this: unknown, _url: string, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError('fetch implementation received the wrong receiver');
      const body = JSON.parse(String(init?.body));
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'targets_list' }] } });
    });
    const client = new McpClient({ fetchImpl });
    client.setCredential('mcpb_receiver_test');

    await expect(client.listTools()).resolves.toEqual([{ name: 'targets_list' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('parses JSON and SSE transport payloads', () => {
    expect(parseTransportPayload('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', 'application/json')).toEqual({
      jsonrpc: '2.0', id: 1, result: { ok: true },
    });
    expect(parseTransportPayload('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n', 'text/event-stream')).toEqual({
      jsonrpc: '2.0', id: 2, result: { ok: true },
    });
  });

  it('prefers structuredContent and falls back to JSON text content', () => {
    expect(structuredFromResult({ structuredContent: { targets: [] } })).toEqual({ targets: [] });
    expect(structuredFromResult({ content: [{ type: 'text', text: '{"ok":true}' }] })).toEqual({ ok: true });
  });

  it('keeps the credential in the request Authorization header and clears it explicitly', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mcpb_console_secret');
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'targets_list' }] } });
    });
    const client = new McpClient({ fetchImpl });
    client.setCredential('mcpb_console_secret');
    await expect(client.listTools()).resolves.toEqual([{ name: 'targets_list' }]);
    expect(client.connected).toBe(true);
    client.clearCredential();
    expect(client.connected).toBe(false);
    await expect(client.listTools()).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps HTTP authentication and authorization failures without exposing raw response internals', async () => {
    const unauth = new McpClient({ fetchImpl: async () => jsonResponse({ error: { message: 'invalid or expired token', data: 'INVALID_CREDENTIAL' } }, 401) });
    unauth.setCredential('bad');
    await expect(unauth.listTools()).rejects.toMatchObject({ name: 'McpClientError', code: 'INVALID_CREDENTIAL', status: 401 });

    const forbidden = new McpClient({ fetchImpl: async () => jsonResponse({ error: { message: 'missing scope files:delete', data: 'FORBIDDEN_SCOPE' } }, 403) });
    forbidden.setCredential('read-only');
    await expect(forbidden.listTools()).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE', status: 403 });
  });

  it('turns a tool isError result into a typed client error', async () => {
    const client = new McpClient({
      fetchImpl: async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: 'FORBIDDEN_TARGET', message: 'target not permitted' }) }],
          },
        });
      },
    });
    client.setCredential('mcpb_key');
    await expect(client.callTool('fs_read', { target: 'nope', path: 'README.md' })).rejects.toMatchObject({
      name: 'McpClientError', code: 'FORBIDDEN_TARGET', status: 403,
    });
  });

  it('rejects mismatched JSON-RPC response ids', async () => {
    const client = new McpClient({ fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 999, result: {} }) });
    client.setCredential('mcpb_key');
    await expect(client.listTools()).rejects.toBeInstanceOf(McpClientError);
    await expect(client.listTools()).rejects.toMatchObject({ code: 'MISMATCHED_RESPONSE' });
  });
});
