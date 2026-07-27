import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const BASE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';

/** Load generated test keys from the scratchpad keys.env. */
export function loadKeys(): Record<string, string> {
  const path = process.env.KEYS_ENV!;
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^KEY_([a-z_]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export async function connect(apiKey: string): Promise<Client> {
  const client = new Client({ name: 'itest', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  await client.connect(transport);
  return client;
}

export interface ToolOut { text: string; isError: boolean; json: any }

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOut> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  let json: any = undefined;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { text, isError: Boolean(res.isError), json };
}

/** Raw fetch to /mcp for auth-level tests (bypasses SDK). */
export async function rawInitialize(headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
  return res.status;
}
