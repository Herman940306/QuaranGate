import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG, DESTRUCTIVE_TOOLS, catalogCoverage } from '../../console/tool-catalog.js';

const expected = [
  'targets_list','target_inspect','target_logs','target_start','target_stop','target_restart',
  'fs_list','fs_stat','fs_read','fs_search','fs_write','fs_patch','fs_delete',
  'terminal_exec','git_status','git_diff','git_log','process_list',
  'agents_list','agent_projects','agent_dispatch','agent_status','agent_result','agent_diff','agent_apply','agent_cancel','agent_discard',
  'github_repositories','github_repository','github_branches','github_commits','github_pull_requests','github_pull_request','github_pull_request_files',
  'github_issues','github_issue','github_issue_comments','github_pull_request_reviews','github_pull_request_review_comments','github_checks',
  'github_push_branch','github_pull_request_create','github_pull_request_update','github_pull_request_review',
  'control_center_query',
];

describe('QuaranGate Console tool catalog', () => {
  it('covers the full U1 source contract exactly once', () => {
    const names = TOOL_CATALOG.map((tool) => tool.name);
    expect(names).toHaveLength(45);
    expect(new Set(names).size).toBe(45);
    expect(new Set(names)).toEqual(new Set(expected));
  });

  it('keeps all mutation/disposition and remote-write operations behind the app-owned confirmation class', () => {
    expect(DESTRUCTIVE_TOOLS).toEqual(new Set([
      'target_start','target_stop','target_restart','fs_delete','agent_apply','agent_cancel','agent_discard',
      'github_push_branch','github_pull_request_create','github_pull_request_update','github_pull_request_review',
    ]));
  });

  it('reports server catalog drift in either direction', () => {
    const exact = catalogCoverage(expected.map((name) => ({ name })));
    expect(exact).toMatchObject({ expected: 45, server: 45, missingFromServer: [], extraOnServer: [] });
    const drift = catalogCoverage([...expected.slice(1).map((name) => ({ name })), { name: 'future_tool' }]);
    expect(drift.missingFromServer).toEqual(['targets_list']);
    expect(drift.extraOnServer).toEqual(['future_tool']);
  });

  it('contains all 17 governed GitHub contracts and the metadata-only Control Center read model', () => {
    expect(TOOL_CATALOG.filter((tool) => tool.category === 'GitHub')).toHaveLength(17);
    expect(TOOL_CATALOG.find((tool) => tool.name === 'control_center_query')).toMatchObject({ authority: 'read', category: 'Control Center' });
  });
});
