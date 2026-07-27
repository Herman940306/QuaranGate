import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, callTool, loadKeys, rawInitialize } from './helpers.js';

const keys = loadKeys();
const T = 'demo';

describe('MCP IDE Bridge — integration (live stack)', () => {
  let vscode: Client;
  let readonly: Client;

  beforeAll(async () => {
    vscode = await connect(keys.vscode);
    readonly = await connect(keys.readonly);
  });
  afterAll(async () => {
    await vscode?.close();
    await readonly?.close();
  });

  describe('authentication', () => {
    it('missing credential -> 401', async () => expect(await rawInitialize({})).toBe(401));
    it('malformed credential -> 401', async () => expect(await rawInitialize({ Authorization: 'Bearer not-a-key' })).toBe(401));
    it('invalid credential -> 401', async () => expect(await rawInitialize({ Authorization: 'Bearer mcpb_vscode_deadbeef' })).toBe(401));
    it('valid credential -> 200', async () => expect(await rawInitialize({ Authorization: `Bearer ${keys.vscode}` })).toBe(200));
    it('X-API-Key header also works', async () => expect(await rawInitialize({ 'X-API-Key': keys.vscode })).toBe(200));
  });

  describe('protocol', () => {
    it('lists all expected tools', async () => {
      const tools = await vscode.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toContain('targets_list');
      expect(names).toContain('terminal_exec');
      expect(names).toContain('fs_patch');
      expect(names.length).toBe(14);
    });
    it('unknown tool call returns an error result', async () => {
      const res: any = await vscode.callTool({ name: 'does_not_exist', arguments: {} });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text ?? '').toContain('not found');
    });
    it('malformed args are rejected (missing required target)', async () => {
      const res: any = await vscode.callTool({ name: 'fs_read', arguments: {} });
      expect(res.isError).toBe(true);
    });
  });

  describe('targets + discovery', () => {
    it('lists the demo target (manual config)', async () => {
      const out = await callTool(vscode, 'targets_list', {});
      const ids = out.json.targets.map((t: any) => t.id);
      expect(ids).toContain(T);
    });
    it('does NOT list the unlabeled decoy container', async () => {
      const out = await callTool(vscode, 'targets_list', {});
      const ids = out.json.targets.map((t: any) => t.id);
      expect(ids.some((i: string) => i.includes('decoy'))).toBe(false);
    });
    it('unknown target is denied', async () => {
      const out = await callTool(vscode, 'target_inspect', { target: 'no-such-target' });
      expect(out.isError).toBe(true);
      expect(out.json.error).toBe('FORBIDDEN_TARGET'); // not in principal's allowlist -> denied before resolution
    });
  });

  describe('authorization', () => {
    it('client forbidden from demo is denied (FORBIDDEN_TARGET)', async () => {
      const forbidden = await connect(keys.forbidden);
      const out = await callTool(forbidden, 'fs_list', { target: T, path: '' });
      expect(out.isError).toBe(true);
      expect(out.json.error).toBe('FORBIDDEN_TARGET');
      await forbidden.close();
    });
    it('read-only client cannot write (FORBIDDEN_SCOPE)', async () => {
      const out = await callTool(readonly, 'fs_write', { target: T, path: 'nope.txt', content: 'x' });
      expect(out.isError).toBe(true);
      expect(out.json.error).toBe('FORBIDDEN_SCOPE');
    });
    it('read-only client can read', async () => {
      const out = await callTool(readonly, 'fs_read', { target: T, path: 'README.md' });
      expect(out.isError).toBe(false);
      expect(out.json.content).toContain('hello from workspace');
    });
  });

  describe('filesystem', () => {
    it('list + stat + read', async () => {
      const list = await callTool(vscode, 'fs_list', { target: T, path: '' });
      expect(list.json.entries.join(' ')).toContain('README.md');
      const stat = await callTool(vscode, 'fs_stat', { target: T, path: 'README.md' });
      expect(stat.json.type).toBe('file');
      const read = await callTool(vscode, 'fs_read', { target: T, path: 'src/app.ts' });
      expect(read.json.content).toContain('export const x');
    });
    it('write + read back', async () => {
      const w = await callTool(vscode, 'fs_write', { target: T, path: 'gen/new.txt', content: 'created-by-test' });
      expect(w.isError).toBe(false);
      const r = await callTool(vscode, 'fs_read', { target: T, path: 'gen/new.txt' });
      expect(r.json.content).toBe('created-by-test');
    });
    it('patch replaces unique text', async () => {
      await callTool(vscode, 'fs_write', { target: T, path: 'gen/patch.txt', content: 'alpha BETA gamma' });
      const p = await callTool(vscode, 'fs_patch', { target: T, path: 'gen/patch.txt', oldText: 'BETA', newText: 'DELTA' });
      expect(p.isError).toBe(false);
      const r = await callTool(vscode, 'fs_read', { target: T, path: 'gen/patch.txt' });
      expect(r.json.content).toBe('alpha DELTA gamma');
    });
    it('patch fails on non-unique text', async () => {
      await callTool(vscode, 'fs_write', { target: T, path: 'gen/dup.txt', content: 'x x' });
      const p = await callTool(vscode, 'fs_patch', { target: T, path: 'gen/dup.txt', oldText: 'x', newText: 'y' });
      expect(p.isError).toBe(true);
      expect(p.json.error).toBe('PATCH_FAILED');
    });
    it('search finds content', async () => {
      const s = await callTool(vscode, 'fs_search', { target: T, query: 'export const', path: '' });
      expect(s.json.matches.join('\n')).toContain('src/app.ts');
    });
    it('delete removes a file', async () => {
      await callTool(vscode, 'fs_write', { target: T, path: 'gen/del.txt', content: 'bye' });
      const d = await callTool(vscode, 'fs_delete', { target: T, path: 'gen/del.txt', recursive: false });
      expect(d.isError).toBe(false);
      const r = await callTool(vscode, 'fs_read', { target: T, path: 'gen/del.txt' });
      expect(r.isError).toBe(true);
    });
  });

  describe('path confinement / isolation', () => {
    it('traversal path is blocked', async () => {
      const out = await callTool(vscode, 'fs_read', { target: T, path: '../../etc/passwd' });
      expect(out.isError).toBe(true);
      expect(out.json.error).toBe('PATH_VIOLATION');
    });
    it('absolute path is blocked', async () => {
      const out = await callTool(vscode, 'fs_read', { target: T, path: '/etc/passwd' });
      expect(out.isError).toBe(true);
      expect(out.json.error).toBe('PATH_VIOLATION');
    });
    it('symlink-to-file escape (escape-passwd -> /etc/passwd) is blocked', async () => {
      const out = await callTool(vscode, 'fs_read', { target: T, path: 'escape-passwd' });
      expect(out.isError).toBe(true);
      expect(out.json.error).toBe('PATH_VIOLATION');
    });
    it('symlink-to-dir escape (escape-dir -> /secretzone) is blocked', async () => {
      const out = await callTool(vscode, 'fs_read', { target: T, path: 'escape-dir/secret.txt' });
      expect(out.isError).toBe(true);
      expect(out.json.error).toBe('PATH_VIOLATION');
    });
    it('secret outside workspace is not reachable via search', async () => {
      const out = await callTool(vscode, 'fs_search', { target: T, query: 'TOP SECRET', path: '' });
      expect(out.json.matches.join('\n')).not.toContain('secret.txt');
    });
  });

  describe('terminal', () => {
    it('runs a command inside the target workspace', async () => {
      const out = await callTool(vscode, 'terminal_exec', { target: T, command: 'pwd && echo hi' });
      expect(out.json.exitCode).toBe(0);
      expect(out.json.stdout).toContain('/workspace');
      expect(out.json.stdout).toContain('hi');
    });
    it('reports non-zero exit codes', async () => {
      const out = await callTool(vscode, 'terminal_exec', { target: T, command: 'exit 7' });
      expect(out.json.exitCode).toBe(7);
    });
    it('enforces timeout', async () => {
      const out = await callTool(vscode, 'terminal_exec', { target: T, command: 'sleep 30', timeoutMs: 1500 });
      expect(out.json.timedOut).toBe(true);
    });
    it('bounds output size', async () => {
      const out = await callTool(vscode, 'terminal_exec', { target: T, command: 'yes ABCDEFGH | head -c 2000000' });
      expect(out.json.truncated).toBe(true);
    });
    it('cwd escape is blocked', async () => {
      const out = await callTool(vscode, 'terminal_exec', { target: T, command: 'pwd', cwd: '../..' });
      expect(out.isError).toBe(true);
      expect(out.json.error).toBe('PATH_VIOLATION');
    });
    it('command runs in the TARGET, not the host (hostname differs)', async () => {
      const out = await callTool(vscode, 'terminal_exec', { target: T, command: 'cat /etc/hostname' });
      // target container id-based hostname, never the WSL host "Wolf"
      expect(out.json.stdout.trim().toLowerCase()).not.toBe('wolf');
    });
  });

  describe('git + processes', () => {
    it('git_status works', async () => {
      const out = await callTool(vscode, 'git_status', { target: T });
      expect(out.json.exitCode).toBe(0);
    });
    it('git_log works', async () => {
      const out = await callTool(vscode, 'git_log', { target: T });
      expect(out.json.stdout).toContain('initial');
    });
    it('process_list works', async () => {
      const out = await callTool(vscode, 'process_list', { target: T });
      expect(out.json.stdout.toLowerCase()).toContain('sleep');
    });
  });
});
