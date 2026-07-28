import { describe, it, expect, afterAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, callTool, loadKeys } from './helpers.js';

const keys = loadKeys();

// Existing-tool regression through a dedicated full-scope test principal,
// proving the 14 original tools still operate after Agent Control Plane (A2).
describe('existing 14 tools still operate (A2 regression)', () => {
  let c: Client;
  afterAll(async () => { await c?.close(); });

  it('exercises fs/terminal/git/process on the demo target', async () => {
    c = await connect(keys.itest_full);
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(20);

    expect((await callTool(c, 'targets_list', {})).json.targets.some((t: any) => t.id === 'demo')).toBe(true);
    expect((await callTool(c, 'target_inspect', { target: 'demo' })).json.running).toBe(true);

    const w = await callTool(c, 'fs_write', { target: 'demo', path: 'gen/a2-regress.txt', content: 'a2 regression ok' });
    expect(w.isError).toBe(false);
    expect((await callTool(c, 'fs_read', { target: 'demo', path: 'gen/a2-regress.txt' })).json.content).toBe('a2 regression ok');
    expect((await callTool(c, 'fs_stat', { target: 'demo', path: 'gen/a2-regress.txt' })).json.type).toBe('file');
    expect((await callTool(c, 'fs_list', { target: 'demo', path: 'gen' })).json.entries.some((e: string) => e.includes('a2-regress.txt'))).toBe(true);
    expect((await callTool(c, 'fs_search', { target: 'demo', query: 'a2 regression', path: 'gen' })).json.matches.length).toBeGreaterThan(0);
    await callTool(c, 'fs_patch', { target: 'demo', path: 'gen/a2-regress.txt', oldText: 'ok', newText: 'done' });
    expect((await callTool(c, 'fs_read', { target: 'demo', path: 'gen/a2-regress.txt' })).json.content).toContain('done');

    expect((await callTool(c, 'terminal_exec', { target: 'demo', command: 'echo PWD=$PWD' })).json.stdout).toContain('PWD=/workspace');
    expect((await callTool(c, 'git_status', { target: 'demo' })).isError).toBe(false);
    expect((await callTool(c, 'git_diff', { target: 'demo' })).isError).toBe(false);
    expect((await callTool(c, 'git_log', { target: 'demo' })).isError).toBe(false);
    expect((await callTool(c, 'process_list', { target: 'demo' })).isError).toBe(false);

    const del = await callTool(c, 'fs_delete', { target: 'demo', path: 'gen/a2-regress.txt' });
    expect(del.isError).toBe(false);
    expect(del.json.ok).toBe(true);

    // A full-scope non-agent principal has ZERO agent access.
    expect((await callTool(c, 'agents_list', {})).isError).toBe(true);
    expect((await callTool(c, 'agent_dispatch', { backend: 'kiro', project: 'mcp-ide-bridge', profile: 'audit', prompt: 'x' })).isError).toBe(true);
  });
});
