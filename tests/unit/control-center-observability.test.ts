import { describe, expect, it, beforeEach, vi } from 'vitest';
import { audit, auditActivityStats, queryAuditActivity, resetAuditActivityForTests } from '../../src/gateway/audit.js';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

describe('U1 bounded Control Center observability', () => {
  beforeEach(() => resetAuditActivityForTests());

  it('retains metadata only for the requesting principal and strips detail from queries', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      audit({ reqId: 'r1', principal: 'alpha', tool: 'fs_read', target: 'demo', decision: 'allow', durationMs: 12, detail: 'path=README.md mcpb_secret' });
      audit({ reqId: 'r2', principal: 'beta', tool: 'terminal_exec', target: 'demo', decision: 'deny', code: 'FORBIDDEN_SCOPE', durationMs: 7, detail: 'secret should not leave the log' });
      const rows = queryAuditActivity({ principal: 'alpha', limit: 100, sinceMs: 3_600_000 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reqId: 'r1', principal: 'alpha', tool: 'fs_read', target: 'demo', decision: 'allow', durationMs: 12 });
      expect(rows[0]).not.toHaveProperty('detail');
      expect(JSON.stringify(rows)).not.toContain('mcpb_secret');
      expect(JSON.stringify(rows)).not.toContain('README.md');
    } finally { out.mockRestore(); }
  });

  it('bounds row reads to 200 while aggregates cover the full retained principal window', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      for (let i = 0; i < 250; i++) audit({ reqId: `r${i}`, principal: 'alpha', tool: i % 2 ? 'targets_list' : 'fs_read', decision: i % 5 === 0 ? 'deny' : 'allow', code: i % 5 === 0 ? 'FORBIDDEN_SCOPE' : undefined, durationMs: i });
      expect(queryAuditActivity({ principal: 'alpha', limit: 999, sinceMs: 3_600_000 })).toHaveLength(200);
      const stats = auditActivityStats('alpha', 3_600_000);
      expect(stats.total).toBe(250);
      expect(stats.allowed + stats.denied).toBe(250);
      expect(stats.denied).toBeGreaterThan(0);
      expect(stats.p50Ms).not.toBeNull();
      expect(stats.p95Ms).not.toBeNull();
      expect(stats.topTools.length).toBeGreaterThan(0);
    } finally { out.mockRestore(); }
  });

  it('keeps the public Control Center API on MCP and refuses generic Docker/host administration', () => {
    const tools = readFileSync(join(root, 'src/gateway/controlCenterTools.ts'), 'utf8');
    const mcp = readFileSync(join(root, 'src/gateway/mcp.ts'), 'utf8');
    expect(mcp).toContain('registerControlCenterTools(server)');
    expect(tools).toContain("server.registerTool('control_center_query'");
    expect(tools).toContain("principalHasScope(p, 'targets:read')");
    expect(tools).toContain("agent_discard: 'agents:dispatch'");
    expect(tools).toContain("dockerAuthority: null, published: null");
    expect(tools).toContain("view: z.enum(VIEWS)");
    expect(tools).not.toMatch(/docker\s+(rm|run|exec|volume|network|compose)/i);
    expect(tools).not.toMatch(/child_process|execShell|fsWrite|fsDelete/);
    expect(tools).not.toContain('keyHash');
  });

  it('exposes only bounded private executor runtime metadata and no Docker selectors', () => {
    const executor = readFileSync(join(root, 'src/executor/index.ts'), 'utf8');
    expect(executor).toContain("app.get('/control-center/runtime'");
    const block = executor.slice(executor.indexOf("app.get('/control-center/runtime'"), executor.indexOf("app.post('/reload'"));
    expect(block).toContain('buildRevision');
    expect(block).toContain('dockerAuthority');
    expect(block).toContain('activeJobs');
    expect(block).toContain('queuedJobs');
    expect(block).not.toMatch(/container(Id|Name)|image(Id|Digest)|mount|network|hostPath|socketPath/);
  });
});
