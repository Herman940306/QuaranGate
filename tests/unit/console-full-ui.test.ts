import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { TOOL_CATALOG } from '../../console/tool-catalog.js';

const root = resolve(import.meta.dirname, '../..');
const app = () => readFileSync(join(root, 'console/app.js'), 'utf8');
const styles = () => readFileSync(join(root, 'console/styles.css'), 'utf8');

describe('QuaranGate Console full U1 product contract', () => {
  it('implements every owner-approved primary route without dead placeholder navigation', () => {
    const text = app();
    for (const route of [
      'overview','chat','projects','targets','files','terminal','git','processes','agents','jobs','review','ide-sessions','github','models','monitoring','statistics','security','audit','recovery','settings','tool-lab',
    ]) expect(text).toContain(`['${route}',`);
    for (const handler of [
      'renderProjects','renderReview','renderIdeSessions','renderGitHub','renderModels','renderMonitoring','renderStatistics','renderSecurity','renderAuditEvidence','renderRecovery','renderSettings',
    ]) expect(text).toContain(`function ${handler}(`);
  });

  it('ships the accepted observability and operations views with truthful unknown/deferred states', () => {
    const text = app();
    for (const term of [
      'MCP Traffic & Activity','Runtime topology & provenance','Source → image → runtime drift','Egress policy monitor','Queue & provider health',
      'Incident center','Resource lifecycle & orphan inspector','Authority Explorer / policy preflight','Evidence lineage / chain of custody',
      'Provider capability / qualification matrix','Session continuity inspector','Managed outside Console',
    ]) expect(text).toContain(term);
    expect(text).toContain('UNKNOWN');
    expect(text).toContain('NOT_IMPLEMENTED');
  });

  it('keeps credentials memory-only and never introduces browser persistence or unsafe browser primitives', () => {
    const text = [app(), readFileSync(join(root, 'console/mcp-client.js'), 'utf8')].join('\n');
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(text).not.toMatch(/\balert\s*\(|\bconfirm\s*\(|\bprompt\s*\(/);
    expect(text).not.toMatch(/\beval\s*\(|new Function/);
  });

  it('provides keyboard command search without bypassing normal tool gates', () => {
    const text = app();
    expect(text).toContain("event.key.toLowerCase() === 'k'");
    expect(text).toContain('openCommandPalette()');
    expect(text).toContain("href:`#/tool-lab`");
    expect(text).not.toContain('paletteExecuteTool');
  });

  it('exposes all seven Files tools through purpose-built modes including read-only fs_stat metadata', () => {
    const text = app();
    expect(text).toContain("['files', 'Files', '7 tools'");

    const modesSource = text.match(/function renderFiles\(\) \{[\s\S]*?const modes = \[([\s\S]*?)\];/)?.[1];
    expect(modesSource).toBeTruthy();
    const modes = [...modesSource!.matchAll(/\['([^']+)', '([^']+)'\]/g)].map((match) => [match[1], match[2]]);
    expect(modes).toEqual([
      ['browse', 'Browse'],
      ['stat', 'Metadata'],
      ['read', 'Read'],
      ['search', 'Search'],
      ['write', 'Write'],
      ['patch', 'Patch'],
      ['delete', 'Delete'],
    ]);
    expect(TOOL_CATALOG).toHaveLength(45);
    expect(TOOL_CATALOG.filter((tool) => tool.category === 'Files').map((tool) => tool.name)).toEqual([
      'fs_list', 'fs_stat', 'fs_read', 'fs_search', 'fs_write', 'fs_patch', 'fs_delete',
    ]);

    const statForm = text.match(/if \(mode === 'stat'\) return `([^`]+)`;/)?.[1];
    expect(statForm).toBeTruthy();
    expect(text).toContain('const sharedStart = `<form id="file-form" novalidate data-mode="${mode}"><div class="field-grid"><div class="field"><label class="field__label" for="file-target">Target</label>${target}</div>`;');
    expect(statForm).toContain('for="file-path">Path');
    expect(statForm).toMatch(/id="file-path"[^>]*\brequired\b/);
    expect(statForm).toContain('placeholder="src/gateway/index.ts"');
    expect(statForm).toContain('Returns type, size, mode and modified time.');

    const runFileForm = text.match(/async function runFileForm\(event\) \{([\s\S]*?)\n\}\n\n/)?.[1];
    expect(runFileForm).toBeTruthy();
    expect(runFileForm).toContain("else if (mode === 'stat') { tool = 'fs_stat'; args = { target, path: path.trim() }; }");
    expect(runFileForm).toContain("const required = mode === 'search' ? form.querySelector('#file-query') : (mode === 'browse' ? null : form.querySelector('#file-path'));");
    expect(runFileForm).toContain("if (!target || (required && !required.value.trim()))");
    expect(runFileForm).toContain("return await safeCall(tool, args, { throwOnError: true })");
    expect(runFileForm).not.toMatch(/client\.callTool\(['\"]fs_stat['\"]/);
    expect(runFileForm).toContain("if (mode === 'delete') {");
    expect(runFileForm).not.toContain("if (mode === 'stat') {\n    result = await openGateDialog");
    expect(text).toContain("stat: 'Read metadata'");
  });

  it('exposes every GitHub read contract through bounded purpose-built repository workflows', () => {
    const text = app();
    const githubCatalog = TOOL_CATALOG.filter((tool) => tool.category === 'GitHub');
    const readCatalog = githubCatalog.filter((tool) => tool.authority === 'read').map((tool) => tool.name);
    const writeCatalog = githubCatalog.filter((tool) => tool.authority !== 'read').map((tool) => tool.name);
    expect(githubCatalog).toHaveLength(17);
    expect(readCatalog).toEqual([
      'github_repositories', 'github_repository', 'github_branches', 'github_commits', 'github_pull_requests', 'github_pull_request',
      'github_pull_request_files', 'github_issues', 'github_issue', 'github_issue_comments', 'github_pull_request_reviews',
      'github_pull_request_review_comments', 'github_checks',
    ]);
    expect(writeCatalog).toEqual([
      'github_push_branch', 'github_pull_request_create', 'github_pull_request_update', 'github_pull_request_review',
    ]);

    const discovery = text.match(/async function loadGitHubRepositories\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(discovery).toBeTruthy();
    expect(discovery).toContain("safeCall('github_repositories', {}, { silent: true })");
    expect(discovery).toContain('state.githubRepositories');

    const githubRoute = text.match(/function renderGitHub\(\) \{([\s\S]*?)\n\}\n\nfunction renderModels/)?.[1];
    expect(githubRoute).toBeTruthy();
    const quickReads = [...githubRoute!.matchAll(/data-github-tool="(github_[a-z_]+)"/g)].map((match) => match[1]);
    expect(quickReads).toEqual(['github_repository', 'github_branches', 'github_pull_requests', 'github_issues']);

    const selectorSource = githubRoute!.match(/nativeSelect\('github-detail-tool', \[([\s\S]*?)\], 'github_commits'\)/)?.[1];
    expect(selectorSource).toBeTruthy();
    const detailReads = [...selectorSource!.matchAll(/\['(github_[a-z_]+)','([^']+)'\]/g)].map((match) => match[1]);
    expect(detailReads).toEqual([
      'github_commits', 'github_pull_request', 'github_pull_request_files', 'github_issue', 'github_issue_comments',
      'github_pull_request_reviews', 'github_pull_request_review_comments', 'github_checks',
    ]);
    expect(detailReads.some((name) => writeCatalog.includes(name))).toBe(false);
    expect(new Set(['github_repositories', ...quickReads, ...detailReads])).toEqual(new Set(readCatalog));

    const detailHandler = githubRoute!.match(/view\.querySelector\('#github-detail-form'\)\?\.addEventListener\('submit', async \(event\) => \{([\s\S]*?)\n  \}\);\n  view\.querySelector\('#github-write-form'/)?.[1];
    expect(detailHandler).toBeTruthy();
    expect(detailHandler).toContain("const repository = view.querySelector('#github-repo').value.trim();");
    expect(detailHandler).toContain("const ref = view.querySelector('#github-detail-ref').value.trim();");
    expect(detailHandler).toContain("const numberRaw = view.querySelector('#github-detail-number').value.trim();");
    expect(detailHandler).toContain("clampInt(view.querySelector('#github-detail-max-items').value, 1, 100, 30)");
    expect(detailHandler).toContain("const refTools = new Set(['github_commits','github_checks']);");
    expect(detailHandler).toContain("const numberTools = new Set(['github_pull_request','github_pull_request_files','github_issue','github_issue_comments','github_pull_request_reviews','github_pull_request_review_comments']);");
    expect(detailHandler).toContain("if (refTools.has(tool) && !ref)");
    expect(detailHandler).toContain("!Number.isInteger(number) || number < 1");
    expect(detailHandler).toContain("if (tool === 'github_commits') args = { repository, ref, maxItems };");
    expect(detailHandler).toContain("else if (tool === 'github_checks') args = { repository, ref };");
    expect(detailHandler).toContain("else if (tool === 'github_pull_request' || tool === 'github_issue') args = { repository, number };");
    expect(detailHandler).toContain("else if (collectionTools.has(tool)) args = { repository, number, maxItems };");
    expect(detailHandler).toContain("const collectionTools = new Set(['github_commits','github_pull_request_files','github_issue_comments','github_pull_request_reviews','github_pull_request_review_comments']);");
    const safeCallIndex = detailHandler!.indexOf('const result = await safeCall(tool, args);');
    expect(safeCallIndex).toBeGreaterThan(detailHandler!.indexOf("if (refTools.has(tool) && !ref)"));
    expect(safeCallIndex).toBeGreaterThan(detailHandler!.indexOf('!Number.isInteger(number) || number < 1'));
    expect(detailHandler).not.toContain('client.callTool');
    expect(detailHandler).not.toContain('openGateDialog');
    expect(detailHandler).toContain("state.routeResults.set('github', result)");
    expect(detailHandler).toContain('renderGitHub();');

    const writeHandler = githubRoute!.match(/view\.querySelector\('#github-write-form'\)\?\.addEventListener\('submit', async \(event\) => \{([\s\S]*?)\n  \}\);/)?.[1];
    expect(writeHandler).toBeTruthy();
    expect(writeHandler).toContain('openGateDialog');
    expect(writeHandler).not.toContain("github-detail-tool");
  });

  it('routes governed GitHub writes through shared safeCall while preserving 401/403 authentication semantics', () => {
    const text = app();
    const githubRoute = text.match(/function renderGitHub\(\) \{([\s\S]*?)\n\}\n\nfunction renderModels/)?.[1];
    expect(githubRoute).toBeTruthy();

    const writeHandler = githubRoute!.match(/view\.querySelector\('#github-write-form'\)\?\.addEventListener\('submit', async \(event\) => \{([\s\S]*?)\n  \}\);/)?.[1];
    expect(writeHandler).toBeTruthy();
    const parseIndex = writeHandler!.indexOf("JSON.parse(view.querySelector('#github-write-json').value)");
    const gateIndex = writeHandler!.indexOf('openGateDialog({');
    expect(parseIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(parseIndex);
    expect(writeHandler).toContain('openGateDialog');
    expect(writeHandler).toContain('action:()=>safeCall(tool, args, { throwOnError: true })');
    expect(writeHandler).not.toContain('client.callTool');
    expect(writeHandler).toContain("if (result && result !== true) { state.routeResults.set('github', result); toast(`${tool} completed.`, 'success'); renderGitHub(); }");

    const githubCatalog = TOOL_CATALOG.filter((tool) => tool.category === 'GitHub');
    expect(githubCatalog.filter((tool) => tool.authority !== 'read').map((tool) => tool.name)).toEqual([
      'github_push_branch', 'github_pull_request_create', 'github_pull_request_update', 'github_pull_request_review',
    ]);

    const safeCall = text.match(/async function safeCall\(name, args, \{ silent = false, throwOnError = false \} = \{\}\) \{([\s\S]*?)\n\}\n/)?.[1];
    expect(safeCall).toBeTruthy();
    const auth401 = safeCall!.match(/if \(err instanceof McpClientError && err\.status === 401\) \{([\s\S]*?)\} else if/)?.[1];
    expect(auth401).toBeTruthy();
    expect(auth401).toContain('disconnect();');
    const auth403 = safeCall!.match(/else if \(err instanceof McpClientError && \(err\.status === 403 \|\| String\(err\.code\)\.startsWith\('FORBIDDEN'\)\)\) \{([\s\S]*?)\} else if/)?.[1];
    expect(auth403).toBeTruthy();
    expect(auth403).toContain('state.deniedTools.set(name, errorMessage(err));');
    expect(auth403).toContain("toast(`${name}: ${errorMessage(err)}`, 'warning')");
    expect(auth403).not.toContain('disconnect');
    expect(auth403).not.toContain('clearCredential');
    expect(safeCall).toContain('if (throwOnError) throw err;');

    const disconnect = text.match(/function disconnect\(\) \{([\s\S]*?)\n\}\n/)?.[1];
    expect(disconnect).toBeTruthy();
    expect(disconnect).toContain('client.clearCredential();');
    expect(disconnect).toContain('state.connected = false;');

    const detailHandler = githubRoute!.match(/view\.querySelector\('#github-detail-form'\)\?\.addEventListener\('submit', async \(event\) => \{([\s\S]*?)\n  \}\);\n  view\.querySelector\('#github-write-form'/)?.[1];
    expect(detailHandler).toBeTruthy();
    expect(detailHandler).toContain('const result = await safeCall(tool, args);');
    expect(detailHandler).not.toContain('client.callTool');
    const selectorSource = githubRoute!.match(/nativeSelect\('github-detail-tool', \[([\s\S]*?)\], 'github_commits'\)/)?.[1];
    expect([...selectorSource!.matchAll(/\['(github_[a-z_]+)','([^']+)'\]/g)].map((match) => match[1])).toEqual([
      'github_commits', 'github_pull_request', 'github_pull_request_files', 'github_issue', 'github_issue_comments',
      'github_pull_request_reviews', 'github_pull_request_review_comments', 'github_checks',
    ]);
  });


  it('enforces per-view latest-request-wins before Control Center state commits', async () => {
    const text = app();
    const controlCenterViewSource = text.match(/async function controlCenterView\(viewName, args = \{\}, \{ silent = true \} = \{\}\) \{[\s\S]*?\n\}\n/)?.[0];
    expect(controlCenterViewSource).toBeTruthy();

    const createDeferred = () => {
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const createHarness = () => {
      const state = {
        connected: true,
        controlCenter: new Map<string, any>(),
        controlCenterEpoch: 0,
        controlCenterRequestVersions: new Map<string, number>(),
      };
      const calls: Array<{ view: string; deferred: ReturnType<typeof createDeferred> }> = [];
      const context: Record<string, any> = {
        state,
        serverHasTool: (name: string) => name === 'control_center_query',
        safeCall: (_name: string, args: { view: string }) => {
          const deferred = createDeferred();
          calls.push({ view: args.view, deferred });
          return deferred.promise;
        },
      };
      runInNewContext(`${controlCenterViewSource}\nglobalThis.__controlCenterView = controlCenterView;`, context);
      return { state, calls, controlCenterView: context.__controlCenterView as (viewName: string, args?: Record<string, unknown>, options?: { silent?: boolean }) => Promise<any> };
    };

    // Core B4 proof: NEW may finish first; OLD may finish later; NEW remains authoritative.
    const latestWins = createHarness();
    const oldRequest = latestWins.controlCenterView('authority', { tool: 'OLD' });
    const newRequest = latestWins.controlCenterView('authority', { tool: 'NEW' });
    latestWins.calls[1].deferred.resolve({ data: { preflight: { requestMarker: 'NEW' } } });
    await newRequest;
    expect(latestWins.state.controlCenter.get('authority').preflight.requestMarker).toBe('NEW');
    latestWins.calls[0].deferred.resolve({ data: { preflight: { requestMarker: 'OLD' } } });
    await oldRequest;
    expect(latestWins.state.controlCenter.get('authority').preflight.requestMarker).toBe('NEW');
    expect(latestWins.state.controlCenter.get('authority').preflight.requestMarker).not.toBe('OLD');

    // Latest failure/UNKNOWN must not be replaced by an older successful response.
    const latestFailure = createHarness();
    const olderSuccess = latestFailure.controlCenterView('authority', { tool: 'OLD' });
    const newerFailure = latestFailure.controlCenterView('authority', { tool: 'NEW' });
    latestFailure.calls[1].deferred.resolve(null);
    await newerFailure;
    expect(latestFailure.state.controlCenter.get('authority')).toEqual({ unavailable: true, state: 'UNKNOWN' });
    latestFailure.calls[0].deferred.resolve({ data: { preflight: { requestMarker: 'OLD' } } });
    await olderSuccess;
    expect(latestFailure.state.controlCenter.get('authority')).toEqual({ unavailable: true, state: 'UNKNOWN' });

    // Lifecycle invalidation prevents a pre-clear response from repopulating Control Center state.
    const lifecycle = createHarness();
    const preReset = lifecycle.controlCenterView('authority', { tool: 'OLD' });
    lifecycle.state.controlCenterEpoch += 1;
    lifecycle.state.controlCenterRequestVersions.clear();
    lifecycle.state.controlCenter.clear();
    lifecycle.calls[0].deferred.resolve({ data: { preflight: { requestMarker: 'OLD' } } });
    await preReset;
    expect(lifecycle.state.controlCenter.has('authority')).toBe(false);

    // Per-view generations do not suppress legitimate responses for unrelated views.
    const independentViews = createHarness();
    const oldAuthority = independentViews.controlCenterView('authority', { tool: 'OLD' });
    const statistics = independentViews.controlCenterView('statistics');
    const newAuthority = independentViews.controlCenterView('authority', { tool: 'NEW' });
    independentViews.calls[1].deferred.resolve({ data: { marker: 'STATISTICS' } });
    await statistics;
    independentViews.calls[2].deferred.resolve({ data: { preflight: { requestMarker: 'NEW' } } });
    await newAuthority;
    independentViews.calls[0].deferred.resolve({ data: { preflight: { requestMarker: 'OLD' } } });
    await oldAuthority;
    expect(independentViews.state.controlCenter.get('statistics').marker).toBe('STATISTICS');
    expect(independentViews.state.controlCenter.get('authority').preflight.requestMarker).toBe('NEW');

    const stateSource = text.match(/const state = \{([\s\S]*?)\n\};/)?.[1];
    expect(stateSource).toContain('controlCenterEpoch: 0');
    expect(stateSource).toContain('controlCenterRequestVersions: new Map()');

    const versionSetIndex = controlCenterViewSource!.indexOf('state.controlCenterRequestVersions.set(viewName, version);');
    const safeCallIndex = controlCenterViewSource!.indexOf("await safeCall('control_center_query'");
    const staleCheckIndex = controlCenterViewSource!.indexOf('state.controlCenterEpoch !== epoch || state.controlCenterRequestVersions.get(viewName) !== version');
    const firstCommitIndex = controlCenterViewSource!.indexOf('state.controlCenter.set(viewName');
    expect(versionSetIndex).toBeGreaterThanOrEqual(0);
    expect(safeCallIndex).toBeGreaterThan(versionSetIndex);
    expect(staleCheckIndex).toBeGreaterThan(safeCallIndex);
    expect(firstCommitIndex).toBeGreaterThan(staleCheckIndex);
    expect(controlCenterViewSource).toContain('if (state.controlCenterEpoch !== epoch || state.controlCenterRequestVersions.get(viewName) !== version) return null;');
    expect(controlCenterViewSource).toContain('if (result?.data) state.controlCenter.set(viewName, result.data);');
    expect(controlCenterViewSource).toContain("else if (state.connected) state.controlCenter.set(viewName, { unavailable: true, state: 'UNKNOWN' });");

    const disconnect = text.match(/function disconnect\(\) \{([\s\S]*?)\n\}\n/)?.[1];
    const refresh = text.match(/async function refreshCurrentRoute\(showToast = false\) \{([\s\S]*?)\n\}\n/)?.[1];
    expect(disconnect).toContain('state.controlCenterEpoch += 1;');
    expect(disconnect).toContain('state.controlCenterRequestVersions.clear();');
    expect(disconnect!.indexOf('state.controlCenterEpoch += 1;')).toBeLessThan(disconnect!.indexOf('state.controlCenter.clear();'));
    expect(disconnect).toContain('client.clearCredential();');
    expect(disconnect).toContain('state.connected = false;');
    expect(disconnect).toContain("location.hash = '#/connect';");
    expect(refresh).toContain('state.controlCenterEpoch += 1;');
    expect(refresh).toContain('state.controlCenterRequestVersions.clear();');
    expect(refresh!.indexOf('state.controlCenterEpoch += 1;')).toBeLessThan(refresh!.indexOf('state.controlCenter.clear();'));

    const preflightHandler = text.match(/function bindPreflightForm\(\) \{([^\n]+)\n/)?.[1];
    expect(preflightHandler).toContain("controlCenterView('authority',args,{silent:false})");
    const githubRoute = text.match(/function renderGitHub\(\) \{([\s\S]*?)\n\}\n\nfunction renderModels/)?.[1];
    expect(githubRoute).toContain('action:()=>safeCall(tool, args, { throwOnError: true })');
    expect(githubRoute).not.toContain('action:()=>client.callTool(tool,args)');
    const githubCatalog = TOOL_CATALOG.filter((tool) => tool.category === 'GitHub');
    expect(githubCatalog.filter((tool) => tool.authority === 'read')).toHaveLength(13);
  });

  it('has responsive and accessible operational styling for new surfaces', () => {
    const text = styles();
    expect(text).toContain('.metric-grid');
    expect(text).toContain('.topology-node');
    expect(text).toContain('.palette-results');
    expect(text).toContain('@media (max-width: 620px)');
    expect(text).toContain('@media (prefers-reduced-motion: reduce)');
    expect(text).toContain('@media (forced-colors: active)');
  });
});
