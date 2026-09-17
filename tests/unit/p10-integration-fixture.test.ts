import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildFixtureDocuments } from '../../scripts/p10-integration-fixture.mjs';

const ids = ['vscode', 'readonly', 'forbidden', 'itest_full', 'itest_agent_owner', 'itest_agent_other'] as const;
const keys = Object.fromEntries(ids.map((id) => [id, `mcpb_${id}_test-secret-${id}`]));

describe('P10 integration fixture documents', () => {
  it('stores only SHA-256 key hashes in clients config and preserves raw keys outside config', () => {
    const docs = buildFixtureDocuments({ targetProject: 'qg-p10-target', sourceRoot: '/home/test/p10-source', keys });
    const serialized = JSON.stringify(docs.clients);
    for (const id of ids) {
      expect(serialized).not.toContain(keys[id]);
      expect(serialized).toContain(createHash('sha256').update(keys[id]).digest('hex'));
    }
  });

  it('binds demo exclusively to the isolated target project with discovery disabled', () => {
    const { bridge } = buildFixtureDocuments({ targetProject: 'qg-p10-target', sourceRoot: '/home/test/p10-source', keys });
    expect(bridge).toEqual({ discovery: { enabled: false }, targets: [{ id: 'demo', composeProject: 'qg-p10-target', composeService: 'dev', workspace: '/workspace' }] });
  });

  it('preserves dedicated target and agent authorization separation', () => {
    const { clients } = buildFixtureDocuments({ targetProject: 'qg-p10-target', sourceRoot: '/home/test/p10-source', keys });
    const byId = Object.fromEntries(clients.clients.map((c) => [c.id, c]));
    expect(byId.forbidden.targets).toEqual([]);
    expect(byId.readonly.scopes).not.toContain('files:write');
    expect(byId.itest_full.scopes.some((s) => s.startsWith('agents:'))).toBe(false);
    expect(byId.itest_agent_owner.scopes).toContain('agents:dispatch');
    expect(byId.itest_agent_other.scopes).not.toContain('agents:dispatch');
    expect(byId.itest_agent_other.scopes).toContain('agents:cancel');
  });

  it('keeps optional GitHub and IDE-session validator inputs unset instead of forcing missing files', () => {
    const source = readFileSync(new URL('../../scripts/p10-integration-fixture.mjs', import.meta.url), 'utf8');
    expect(source).toContain('delete validationEnv.GITHUB_CONFIG');
    expect(source).toContain('delete validationEnv.IDE_SESSIONS_CONFIG');
    expect(source).not.toContain('__absent-github.yaml');
    expect(source).not.toContain('__absent-ide.yaml');
  });

  it('binds trusted agent project hostPath to the exact supplied qualification source root', () => {
    const { agents } = buildFixtureDocuments({ targetProject: 'qg-p10-target', sourceRoot: '/home/test/p10-source', keys });
    expect(agents.projects).toHaveLength(1);
    expect(agents.projects[0]).toMatchObject({ id: 'mcp-ide-bridge', hostPath: '/home/test/p10-source', gitRequired: true, backends: ['kiro'] });
    expect(agents.backends).toEqual([{ id: 'kiro', enabled: true, profiles: ['audit', 'plan', 'implement', 'review'], defaultResourcePolicy: 'standard' }]);
  });
});
