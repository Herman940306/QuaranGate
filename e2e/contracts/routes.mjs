export const AUTHORITATIVE_ROUTES = Object.freeze([
  Object.freeze({ id: 'overview', label: 'Overview', href: '#/overview', hash: '#/overview' }),
  Object.freeze({ id: 'chat', label: 'Chat', href: '#/chat', hash: '#/chat' }),
  Object.freeze({ id: 'projects', label: 'Projects', href: '#/projects', hash: '#/projects' }),
  Object.freeze({ id: 'targets', label: 'Targets', href: '#/targets', hash: '#/targets' }),
  Object.freeze({ id: 'files', label: 'Files', href: '#/files', hash: '#/files' }),
  Object.freeze({ id: 'terminal', label: 'Terminal', href: '#/terminal', hash: '#/terminal' }),
  Object.freeze({ id: 'git', label: 'Git', href: '#/git', hash: '#/git' }),
  Object.freeze({ id: 'processes', label: 'Processes', href: '#/processes', hash: '#/processes' }),
  Object.freeze({ id: 'agents', label: 'Agents', href: '#/agents', hash: '#/agents' }),
  Object.freeze({ id: 'jobs', label: 'Jobs', href: '#/jobs', hash: '#/jobs' }),
  Object.freeze({ id: 'review', label: 'Review & Approvals', href: '#/review', hash: '#/review' }),
  Object.freeze({ id: 'ide-sessions', label: 'IDE Sessions', href: '#/ide-sessions', hash: '#/ide-sessions' }),
  Object.freeze({ id: 'github', label: 'GitHub', href: '#/github', hash: '#/github' }),
  Object.freeze({ id: 'models', label: 'Local AI / Models', href: '#/models', hash: '#/models' }),
  Object.freeze({ id: 'monitoring', label: 'Monitoring', href: '#/monitoring', hash: '#/monitoring' }),
  Object.freeze({ id: 'statistics', label: 'Statistics', href: '#/statistics', hash: '#/statistics' }),
  Object.freeze({ id: 'security', label: 'Security & Access', href: '#/security', hash: '#/security' }),
  Object.freeze({ id: 'audit', label: 'Audit & Evidence', href: '#/audit', hash: '#/audit' }),
  Object.freeze({ id: 'recovery', label: 'Recovery & Backups', href: '#/recovery', hash: '#/recovery' }),
  Object.freeze({ id: 'settings', label: 'Settings', href: '#/settings', hash: '#/settings' }),
  Object.freeze({ id: 'tool-lab', label: 'Tool Lab', href: '#/tool-lab', hash: '#/tool-lab' }),
]);

export function assertAuthoritativeRouteShape(routes = AUTHORITATIVE_ROUTES) {
  if (routes.length !== 21) throw new Error(`authoritative route count mismatch: ${routes.length}`);
  for (const key of ['id', 'label', 'href']) {
    if (new Set(routes.map((route) => route[key])).size !== 21) throw new Error(`authoritative route ${key} values are not unique`);
  }
  return true;
}

assertAuthoritativeRouteShape();
