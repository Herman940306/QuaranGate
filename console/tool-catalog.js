const t = (name, category, authority, summary, defaults = {}) => ({ name, category, authority, summary, defaults });

export const TOOL_CATALOG = Object.freeze([
  t('targets_list','Targets','read','List targets authorized for this principal.'),
  t('target_inspect','Targets','read','Inspect one authorized target.',{target:''}),
  t('target_logs','Targets','read','Read bounded stdout/stderr from a manual target.',{target:'',maxBytes:32768}),
  t('target_start','Targets','danger','Start an existing authorized target container.',{target:''}),
  t('target_stop','Targets','danger','Stop an existing authorized target container.',{target:''}),
  t('target_restart','Targets','danger','Restart a running authorized target container.',{target:''}),
  t('fs_list','Files','read','List entries under a workspace-relative directory.',{target:'',path:'',maxDepth:2}),
  t('fs_stat','Files','read','Read type, size, mode and modified time for a path.',{target:'',path:''}),
  t('fs_read','Files','read','Read UTF-8/binary file content from the workspace.',{target:'',path:''}),
  t('fs_search','Files','read','Run bounded fixed-string recursive search.',{target:'',query:'',path:'',maxResults:100}),
  t('fs_write','Files','write','Create or overwrite a workspace-relative file.',{target:'',path:'',content:''}),
  t('fs_patch','Files','write','Replace one unique exact substring in a file.',{target:'',path:'',oldText:'',newText:''}),
  t('fs_delete','Files','danger','Delete a file or directory when authorized.',{target:'',path:'',recursive:false}),
  t('terminal_exec','Terminal','exec','Run a bounded shell command inside the target workspace.',{target:'',command:'',cwd:'',timeoutMs:120000}),
  t('git_status','Git','read','Read Git working-state status.',{target:''}),
  t('git_diff','Git','read','Read Git diff statistics.',{target:''}),
  t('git_log','Git','read','Read the last 30 Git commits.',{target:''}),
  t('process_list','Processes','read','List processes inside the target.',{target:''}),
  t('agents_list','Agents','read','List configured agent backends and available profiles.'),
  t('agent_projects','Agents','read','List logical projects available to agent dispatch.'),
  t('agent_dispatch','Agents','write','Create a governed asynchronous agent job.',{backend:'ollama',project:'',profile:'audit',prompt:'',resourcePolicy:'standard'}),
  t('agent_status','Jobs','read','Read lifecycle state for an owned job.',{jobId:''}),
  t('agent_result','Jobs','read','Read normalized completion/failure evidence.',{jobId:''}),
  t('agent_diff','Jobs','read','Review bounded canonical change evidence.',{jobId:'',maxBytes:65536}),
  t('agent_apply','Jobs','danger','Apply stored, re-verified evidence to the registered live project.',{jobId:''}),
  t('agent_cancel','Jobs','danger','Permanently cancel an active owned job.',{jobId:''}),
  t('agent_discard','Jobs','danger','Durably discard a completed job artifact without host mutation.',{jobId:''}),
  t('github_repositories','GitHub','read','Discover repositories visible through trusted QuaranHUB installations.'),
  t('github_repository','GitHub','read','Read repository metadata.',{repository:''}),
  t('github_branches','GitHub','read','List bounded branch state.',{repository:'',maxItems:50}),
  t('github_commits','GitHub','read','Read bounded commit history.',{repository:'',ref:'main',maxItems:30}),
  t('github_pull_requests','GitHub','read','List pull requests.',{repository:'',state:'open',maxItems:30}),
  t('github_pull_request','GitHub','read','Read one pull request.',{repository:'',number:1}),
  t('github_pull_request_files','GitHub','read','Read bounded PR file metadata and patch text.',{repository:'',number:1,maxItems:50}),
  t('github_issues','GitHub','read','List issues.',{repository:'',state:'open',maxItems:30}),
  t('github_issue','GitHub','read','Read one issue.',{repository:'',number:1}),
  t('github_issue_comments','GitHub','read','Read issue comments.',{repository:'',number:1,maxItems:50}),
  t('github_pull_request_reviews','GitHub','read','Read submitted pull-request reviews.',{repository:'',number:1,maxItems:50}),
  t('github_pull_request_review_comments','GitHub','read','Read pull-request review comments.',{repository:'',number:1,maxItems:50}),
  t('github_checks','GitHub','read','Read commit status compatibility data.',{repository:'',ref:'main'}),
  t('github_push_branch','GitHub','danger','Push one exact trusted local HEAD to a bounded non-protected branch.',{project:'',expectedHead:'',remoteBranch:''}),
  t('github_pull_request_create','GitHub','danger','Create a pull request without merge authority.',{repository:'',head:'',base:'main',title:'',body:'',draft:false}),
  t('github_pull_request_update','GitHub','danger','Update bounded pull-request metadata/state.',{repository:'',number:1,title:''}),
  t('github_pull_request_review','GitHub','danger','Submit COMMENT, APPROVE or REQUEST_CHANGES.',{repository:'',number:1,event:'COMMENT',body:''}),
  t('control_center_query','Control Center','read','Read bounded metadata-only Control Center observability views.',{view:'summary',limit:100,sinceMs:3600000}),
]);

export const TOOL_BY_NAME = Object.freeze(Object.fromEntries(TOOL_CATALOG.map((tool) => [tool.name, tool])));
export const TOOL_GROUPS = Object.freeze([...new Set(TOOL_CATALOG.map((tool) => tool.category))]);
export const DESTRUCTIVE_TOOLS = new Set(TOOL_CATALOG.filter((tool) => tool.authority === 'danger').map((tool) => tool.name));
export const ACTIVE_JOB_STATUSES = new Set(['QUEUED','PREPARING','RUNNING','VALIDATING','RESERVED']);
export const TERMINAL_JOB_STATUSES = new Set(['COMPLETED','FAILED_PRECONDITION','FAILED_POLICY','FAILED_AGENT','FAILED_TIMEOUT','FAILED_INFRASTRUCTURE','CANCELLED','APPLIED','DISCARDED','UNCERTAIN']);
export function authorityLabel(authority) { return ({ read:'Read', write:'Write', exec:'Execution', danger:'Destructive' })[authority] ?? 'Read'; }
export function classifyTool(name) { return TOOL_BY_NAME[name]?.authority ?? 'read'; }
export function catalogCoverage(serverTools = []) {
  const serverNames = new Set(serverTools.map((tool) => tool?.name).filter(Boolean));
  const localNames = new Set(TOOL_CATALOG.map((tool) => tool.name));
  return { expected: TOOL_CATALOG.length, server: serverNames.size, missingFromServer:[...localNames].filter((name)=>!serverNames.has(name)), extraOnServer:[...serverNames].filter((name)=>!localNames.has(name)) };
}
