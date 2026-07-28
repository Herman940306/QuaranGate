import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, loadKeys } from './helpers.js';

const keys = loadKeys();
const T = 'demo';

describe('MCP structured tool outputs', () => {
  let vscode: Client;

  beforeAll(async () => {
    vscode = await connect(keys.vscode);
  });

  afterAll(async () => {
    await vscode?.close();
  });

  it('advertises an object outputSchema for all 20 operational tools', async () => {
    // 14 original tools + 6 activated Agent Control Plane tools (Phase A2).
    const { tools } = await vscode.listTools();
    expect(tools).toHaveLength(20);

    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} missing outputSchema`).toBeTruthy();
      expect(tool.outputSchema?.type, `${tool.name} outputSchema must be an object`).toBe('object');
    }

    // The three review/apply-lifecycle contracts stay unregistered until A6.
    const names = tools.map((t) => t.name);
    for (const t of ['agent_diff', 'agent_apply', 'agent_discard']) {
      expect(names, `${t} must remain contract-only`).not.toContain(t);
    }
  });

  it('returns structuredContent while preserving JSON text content', async () => {
    const res: any = await vscode.callTool({ name: 'targets_list', arguments: {} });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toBeTruthy();
    expect(res.structuredContent).toEqual(JSON.parse(res.content?.[0]?.text ?? 'null'));
    expect(res.structuredContent.targets.some((t: any) => t.id === T)).toBe(true);
  });

  it('validates successful target_inspect structured output', async () => {
    const res: any = await vscode.callTool({ name: 'target_inspect', arguments: { target: T } });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent?.id).toBe(T);
    expect(res.structuredContent?.running).toBe(true);
    expect(res.structuredContent?.workspace).toBe('/workspace');
  });
});
