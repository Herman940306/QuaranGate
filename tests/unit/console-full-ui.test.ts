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

  it('renders authoritative UNKNOWN for exact duplicate preflight without stale visible authority', async () => {
    const text = app();
    const renderSecuritySource = text.match(/function renderSecurity\(\) \{[\s\S]*?\n\}\n/)?.[0];
    const preflightFormSource = text.match(/function preflightForm\(result\) \{[^\n]+\n/)?.[0];
    const bindPreflightFormSource = text.match(/function bindPreflightForm\(\) \{[^\n]+\n/)?.[0];
    const controlCenterViewSource = text.match(/async function controlCenterView\(viewName, args = \{\}, \{ silent = true \} = \{\}\) \{[\s\S]*?\n\}\n/)?.[0];
    const safeCallSource = text.match(/async function safeCall\(name, args, \{ silent = false, throwOnError = false \} = \{\}\) \{[\s\S]*?\n\}\n/)?.[0];
    expect(renderSecuritySource).toBeTruthy();
    expect(preflightFormSource).toBeTruthy();
    expect(bindPreflightFormSource).toBeTruthy();
    expect(controlCenterViewSource).toBeTruthy();
    expect(safeCallSource).toBeTruthy();

    const createDeferred = () => {
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((done) => { resolve = done; });
      return { promise, resolve };
    };

    const createHarness = (initialMarker = 'PREVIOUS_ALLOW') => {
      const state = {
        connected: true,
        controlCenter: new Map<string, any>([['authority', { preflight: { requestMarker: initialMarker } }]]),
        controlCenterEpoch: 0,
        controlCenterRequestVersions: new Map<string, number>(),
        pending: new Set<string>(),
        pendingRequestOwners: new Map<string, number>(),
        pendingRequestVersion: 0,
        connectionEpoch: 0,
        deniedTools: new Map<string, string>(),
        selectedTarget: '',
        projects: [] as Array<{ id: string }>,
        backends: [] as Array<{ id: string }>,
      };
      const physicalCalls: Array<{ args: Record<string, any>; deferred: ReturnType<typeof createDeferred> }> = [];
      const toasts: string[] = [];
      let submitHandler: ((event: any) => Promise<void>) | undefined;
      let visible = initialMarker;
      let renderCount = 0;
      let primeCount = 0;
      let toolValue = 'agent_apply';
      const form = {
        querySelector: (selector: string) => ({
          value: selector === '#preflight-tool' ? toolValue : '',
        }),
      };
      const view = {
        get innerHTML() { return visible; },
        set innerHTML(value: string) { visible = value; renderCount += 1; },
        querySelector: (selector: string) => selector === '#preflight-form'
          ? { addEventListener: (_event: string, handler: (event: any) => Promise<void>) => { submitHandler = handler; } }
          : null,
      };
      class McpClientError extends Error {
        status?: number;
        code?: string;
        constructor(message: string, details: Record<string, any> = {}) { super(message); Object.assign(this, details); }
      }
      const context: Record<string, any> = {
        state,
        view,
        McpClientError,
        client: {
          callTool: (_name: string, args: Record<string, any>) => {
            const deferred = createDeferred();
            physicalCalls.push({ args, deferred });
            return deferred.promise;
          },
        },
        serverHasTool: (name: string) => name === 'control_center_query',
        toast: (message: string) => { toasts.push(message); },
        errorMessage: (error: Error) => error.message,
        disconnect: () => { state.connected = false; state.controlCenterEpoch += 1; state.controlCenterRequestVersions.clear(); state.controlCenter.clear(); },
        currentRoute: () => 'security',
        primeControlCenterViews: () => { primeCount += 1; },
        keyValuePanel: (value: unknown) => `PANEL:${JSON.stringify(value)}`,
        loadingBlock: (message: string) => `LOADING:${message}`,
        escapeAttr: (value: unknown) => String(value ?? ''),
      };
      runInNewContext([
        renderSecuritySource,
        preflightFormSource,
        bindPreflightFormSource,
        controlCenterViewSource,
        safeCallSource,
        'globalThis.__bindPreflightForm = bindPreflightForm;',
      ].join('\n'), context);
      context.__bindPreflightForm();
      const submit = () => {
        if (!submitHandler) throw new Error('preflight submit handler was not bound');
        return submitHandler({ preventDefault() {}, currentTarget: form });
      };
      return {
        state,
        physicalCalls,
        toasts,
        submit,
        setTool: (value: string) => { toolValue = value; },
        visible: () => visible,
        renderCount: () => renderCount,
        primeCount: () => primeCount,
      };
    };

    // Exact duplicate: second logical request advances the generation but safeCall sends only one physical call.
    const duplicate = createHarness('PREVIOUS_ALLOW');
    const first = duplicate.submit();
    expect(duplicate.physicalCalls).toHaveLength(1);
    const second = duplicate.submit();
    await second;
    expect(duplicate.physicalCalls).toHaveLength(1);
    expect(duplicate.state.controlCenter.get('authority')).toEqual({ unavailable: true, state: 'UNKNOWN' });
    expect(duplicate.visible()).toContain('UNKNOWN');
    expect(duplicate.visible()).not.toContain('PREVIOUS_ALLOW');
    duplicate.physicalCalls[0].deferred.resolve({ data: { preflight: { requestMarker: 'PREVIOUS_ALLOW' } } });
    await first;
    expect(duplicate.state.controlCenter.get('authority')).toEqual({ unavailable: true, state: 'UNKNOWN' });
    expect(duplicate.visible()).toContain('UNKNOWN');
    expect(duplicate.visible()).not.toContain('PREVIOUS_ALLOW');

    const duplicateDeny = createHarness('PREVIOUS_DENY');
    const denyFirst = duplicateDeny.submit();
    const denySecond = duplicateDeny.submit();
    await denySecond;
    expect(duplicateDeny.physicalCalls).toHaveLength(1);
    expect(duplicateDeny.state.controlCenter.get('authority')).toEqual({ unavailable: true, state: 'UNKNOWN' });
    expect(duplicateDeny.visible()).toContain('UNKNOWN');
    expect(duplicateDeny.visible()).not.toContain('PREVIOUS_DENY');
    duplicateDeny.physicalCalls[0].deferred.resolve({ data: { preflight: { requestMarker: 'PREVIOUS_DENY' } } });
    await denyFirst;
    expect(duplicateDeny.state.controlCenter.get('authority')).toEqual({ unavailable: true, state: 'UNKNOWN' });
    expect(duplicateDeny.visible()).toContain('UNKNOWN');
    expect(duplicateDeny.visible()).not.toContain('PREVIOUS_DENY');

    // A latest different request that returns no data must visibly own UNKNOWN over an older later success.
    const latestFailureVisible = createHarness('PREVIOUS_ALLOW');
    latestFailureVisible.setTool('OLD');
    const oldSuccess = latestFailureVisible.submit();
    latestFailureVisible.setTool('NEW');
    const newestFailure = latestFailureVisible.submit();
    expect(latestFailureVisible.physicalCalls).toHaveLength(2);
    latestFailureVisible.physicalCalls[1].deferred.resolve(null);
    await newestFailure;
    expect(latestFailureVisible.state.controlCenter.get('authority')).toEqual({ unavailable: true, state: 'UNKNOWN' });
    expect(latestFailureVisible.visible()).toContain('UNKNOWN');
    expect(latestFailureVisible.visible()).not.toContain('PREVIOUS_ALLOW');
    latestFailureVisible.physicalCalls[0].deferred.resolve({ data: { preflight: { requestMarker: 'OLD' } } });
    await oldSuccess;
    expect(latestFailureVisible.state.controlCenter.get('authority')).toEqual({ unavailable: true, state: 'UNKNOWN' });
    expect(latestFailureVisible.visible()).toContain('UNKNOWN');
    expect(latestFailureVisible.visible()).not.toContain('OLD');

    // A stale OLD completion while a different NEW request is still pending must not render/prime from an absent cache.
    const pendingNew = createHarness('PREVIOUS_DENY');
    pendingNew.setTool('OLD');
    const old = pendingNew.submit();
    pendingNew.setTool('NEW');
    const newer = pendingNew.submit();
    expect(pendingNew.physicalCalls).toHaveLength(2);
    pendingNew.physicalCalls[0].deferred.resolve({ data: { preflight: { requestMarker: 'OLD' } } });
    await old;
    expect(pendingNew.state.controlCenter.has('authority')).toBe(false);
    expect(pendingNew.renderCount()).toBe(0);
    expect(pendingNew.primeCount()).toBe(0);
    pendingNew.physicalCalls[1].deferred.resolve({ data: { preflight: { requestMarker: 'NEW' } } });
    await newer;
    expect(pendingNew.state.controlCenter.get('authority').preflight.requestMarker).toBe('NEW');
    expect(pendingNew.renderCount()).toBe(1);
    expect(pendingNew.primeCount()).toBe(0);
    expect(pendingNew.visible()).toContain('NEW');
    expect(pendingNew.visible()).not.toContain('PREVIOUS_DENY');

    // Source structure binds rendering to authoritative cache presence and renders UNKNOWN explicitly.
    expect(renderSecuritySource).toContain("const preflight=authority?.preflight ?? (authority?.unavailable ? { unavailable:true, state:authority.state ?? 'UNKNOWN' } : null);");
    expect(renderSecuritySource).toContain('${preflightForm(preflight)}');
    expect(bindPreflightFormSource).toContain("await controlCenterView('authority',args,{silent:false});");
    expect(bindPreflightFormSource).toContain("if(state.controlCenter.has('authority') && currentRoute()==='security') renderSecurity();");
    expect(bindPreflightFormSource).not.toContain('const data=await controlCenterView');
    expect(safeCallSource).toContain('if (state.pending.has(key))');
    expect(safeCallSource).toContain("code: 'DUPLICATE_REQUEST'");
  });

  it('invalidates stale core-data loads and suppresses stale lifecycle continuations', async () => {
    const text = app();
    const loadCoreDataSource = text.match(/async function loadCoreData\(\) \{[\s\S]*?\n\}\n/)?.[0];
    const disconnectSource = text.match(/function disconnect\(\) \{[\s\S]*?\n\}\n/)?.[0];
    const refreshSource = text.match(/async function refreshCurrentRoute\(showToast = false\) \{[\s\S]*?\n\}\n/)?.[0];
    const targetControlSource = text.match(/async function runTargetControl\(tool, button\) \{[\s\S]*?\n\}\n/)?.[0];
    const renderConnectSource = text.match(/function renderConnect\(\) \{([\s\S]*?)\n\}\n\nasync function loadCoreData/)?.[1];
    const connectSubmitBody = renderConnectSource?.match(/form\.addEventListener\('submit', async \(event\) => \{([\s\S]*?)\n  \}\);/)?.[1];
    expect(loadCoreDataSource).toBeTruthy();
    expect(disconnectSource).toBeTruthy();
    expect(refreshSource).toBeTruthy();
    expect(targetControlSource).toBeTruthy();
    expect(connectSubmitBody).toBeTruthy();

    const createDeferred = () => {
      let resolve!: (value: any) => void;
      const promise = new Promise<any>((done) => { resolve = done; });
      return { promise, resolve };
    };

    const createHarness = () => {
      const state: Record<string, any> = {
        connected: true,
        serverTools: [{ name: 'control_center_query' }],
        targets: [],
        targetDetails: new Map(),
        backends: [],
        projects: [],
        jobs: new Map(),
        deniedTools: new Map(),
        selectedTarget: '',
        selectedJobId: '',
        toolResults: new Map(),
        routeResults: new Map(),
        pending: new Set(),
        pendingRequestOwners: new Map(),
        pendingRequestVersion: 0,
        connectionEpoch: 0,
        chatMessages: [],
        chatJobId: '',
        chatPollingController: null,
        chatConfig: { backend: '', project: '', profile: 'audit', resourcePolicy: 'standard' },
        controlCenter: new Map(),
        controlCenterEpoch: 0,
        controlCenterRequestVersions: new Map(),
        coreDataEpoch: 0,
        coreDataRequestVersion: 0,
        coreDataActivePromise: null,
        githubRepositories: [],
        githubLoaded: false,
        selectedGithubRepository: '',
      };
      const calls: Array<{ name: string; deferred: ReturnType<typeof createDeferred> }> = [];
      const toasts: Array<{ message: string; tone?: string }> = [];
      const busy: any[] = [];
      let renderRouteCount = 0;
      let renderTargetsCount = 0;
      let announced = '';
      const location = { hash: '#/targets' };
      const app = { dataset: { connected: 'true' } };
      const connectionLabel = { textContent: 'Connected' };
      const disconnectButton = { hidden: false, disabled: false };
      const refreshButton = {};
      const client = {
        clearCredential() {},
        setCredential(_value: string) {},
        async listTools() { return [{ name: 'control_center_query' }]; },
        async callTool(_name: string, _args: any) { return null; },
      };
      const safeCall = (name: string) => {
        const deferred = createDeferred();
        calls.push({ name, deferred });
        return deferred.promise;
      };
      const context: Record<string, any> = {
        state,
        client,
        app,
        connectionLabel,
        disconnectButton,
        refreshButton,
        location,
        safeCall,
        serverHasTool: (name: string) => name === 'control_center_query' && state.serverTools.some((tool: any) => tool.name === name),
        announce: (message: string) => { announced = message; },
        setButtonBusy: (...args: any[]) => { busy.push(args); },
        renderRoute: () => { renderRouteCount += 1; },
        renderTargets: () => { renderTargetsCount += 1; },
        toast: (message: string, tone?: string) => { toasts.push({ message, tone }); },
        errorMessage: (error: any) => error?.message ?? String(error),
        currentRoute: () => location.hash.replace(/^#\/?/, '') || 'overview',
        openGateDialog: async () => ({ ok: true }),
        capitalize: (value: string) => value,
        TOOL_CATALOG: [],
      };
      runInNewContext([
        loadCoreDataSource,
        disconnectSource,
        refreshSource,
        targetControlSource,
        `globalThis.__connectSubmit = async function(event) {${connectSubmitBody}\n};`,
        'globalThis.__loadCoreData = loadCoreData;',
        'globalThis.__disconnect = disconnect;',
        'globalThis.__refreshCurrentRoute = refreshCurrentRoute;',
        'globalThis.__runTargetControl = runTargetControl;',
      ].join('\n'), context);

      const resolveLoad = (index: number, marker: string) => {
        const group = calls.slice(index * 4, index * 4 + 4);
        expect(group).toHaveLength(4);
        for (const entry of group) {
          if (entry.name === 'targets_list') entry.deferred.resolve({ targets: [{ id: `target-${marker}`, running: true }] });
          else if (entry.name === 'agents_list') entry.deferred.resolve({ backends: [{ id: `backend-${marker}`, available: true }] });
          else if (entry.name === 'agent_projects') entry.deferred.resolve({ projects: [{ id: `project-${marker}` }] });
          else if (entry.name === 'control_center_query') entry.deferred.resolve({ data: { marker } });
          else throw new Error(`unexpected core call ${entry.name}`);
        }
      };
      const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
      return {
        state, calls, toasts, busy, location, app, connectionLabel, disconnectButton, refreshButton, client,
        loadCoreData: context.__loadCoreData as () => Promise<boolean>,
        disconnect: context.__disconnect as () => void,
        refreshCurrentRoute: context.__refreshCurrentRoute as (showToast?: boolean) => Promise<void>,
        runTargetControl: context.__runTargetControl as (tool: string, button: any) => Promise<void>,
        connectSubmit: context.__connectSubmit as (event: any) => Promise<void>,
        resolveLoad, flush,
        renderRouteCount: () => renderRouteCount,
        renderTargetsCount: () => renderTargetsCount,
        announced: () => announced,
      };
    };

    // A pre-disconnect core load must not repopulate cleared browser state.
    const disconnected = createHarness();
    const preDisconnect = disconnected.loadCoreData();
    expect(disconnected.calls).toHaveLength(4);
    disconnected.disconnect();
    disconnected.resolveLoad(0, 'A');
    await preDisconnect;
    expect(disconnected.state.controlCenter.has('summary')).toBe(false);
    expect(disconnected.state.targets).toEqual([]);
    expect(disconnected.state.backends).toEqual([]);
    expect(disconnected.state.projects).toEqual([]);
    expect(disconnected.state.selectedTarget).toBe('');
    expect(disconnected.state.chatConfig.backend).toBe('');
    expect(disconnected.state.chatConfig.project).toBe('');

    // Principal A cannot overwrite newer Principal B after reconnect.
    const principal = createHarness();
    const principalA = principal.loadCoreData();
    principal.disconnect();
    principal.state.connected = true;
    principal.state.serverTools = [{ name: 'control_center_query' }];
    const principalB = principal.loadCoreData();
    principal.resolveLoad(1, 'B');
    expect(await principalB).toBe(true);
    principal.resolveLoad(0, 'A');
    expect(await principalA).toBe(false);
    expect(principal.state.controlCenter.get('summary')).toEqual({ marker: 'B' });
    expect(principal.state.targets[0].id).toBe('target-B');
    expect(principal.state.backends[0].id).toBe('backend-B');
    expect(principal.state.projects[0].id).toBe('project-B');

    // Same-lifecycle overlap: OLD physical work settles stale, then NEW runs a fresh coherent snapshot.
    const latest = createHarness();
    const oldLoad = latest.loadCoreData();
    const newLoad = latest.loadCoreData();
    expect(latest.calls).toHaveLength(4);
    latest.resolveLoad(0, 'OLD');
    expect(await oldLoad).toBe(false);
    await latest.flush();
    expect(latest.calls).toHaveLength(8);
    latest.resolveLoad(1, 'NEW');
    expect(await newLoad).toBe(true);
    expect(latest.state.controlCenter.get('summary')).toEqual({ marker: 'NEW' });
    expect(latest.state.targets[0].id).toBe('target-NEW');

    // Connect continuation must not claim success after disconnect invalidates its load.
    const connect = createHarness();
    connect.state.connected = false;
    connect.location.hash = '#/connect';
    const keyInput: any = { value: 'secret', removeAttribute() {}, setAttribute() {}, focus() {} };
    const error: any = { textContent: '' };
    const status: any = { textContent: '' };
    const submit: any = {};
    Object.assign((connect.connectSubmit as any), {});
    const connectContext = (connect.connectSubmit as any);
    // VM globals are referenced by name; expose the form-local bindings through the function context.
    (connectContext as any);
    // Re-evaluate only the exact extracted submit body with controlled form bindings.
    const connectBodyContext: Record<string, any> = {
      state: connect.state, client: connect.client, app: connect.app, connectionLabel: connect.connectionLabel,
      disconnectButton: connect.disconnectButton, location: connect.location, loadCoreData: connect.loadCoreData,
      toast: (message: string, tone?: string) => { connect.toasts.push({ message, tone }); },
      errorMessage: (e: any) => e?.message ?? String(e), setButtonBusy: () => {}, TOOL_CATALOG: [],
      keyInput, error, status, submit,
    };
    runInNewContext(`globalThis.__submit = async function(event) {${connectSubmitBody}\n};`, connectBodyContext);
    const connecting = connectBodyContext.__submit({ preventDefault() {} });
    await connect.flush();
    expect(connect.calls).toHaveLength(4);
    connect.disconnect();
    connect.resolveLoad(0, 'A');
    await connecting;
    expect(connect.location.hash).toBe('#/connect');
    expect(connect.toasts.some((entry) => entry.message === 'Connected to QuaranGate.' && entry.tone === 'success')).toBe(false);

    // Refresh made stale by disconnect cannot render or report a successful refresh.
    const refresh = createHarness();
    const refreshing = refresh.refreshCurrentRoute(true);
    expect(refresh.calls).toHaveLength(4);
    refresh.disconnect();
    refresh.resolveLoad(0, 'A');
    await refreshing;
    expect(refresh.renderRouteCount()).toBe(0);
    expect(refresh.toasts.some((entry) => entry.message === 'Console data refreshed.' && entry.tone === 'success')).toBe(false);

    // Target-control continuation must not render after invalidation or after navigation away.
    const target = createHarness();
    target.state.selectedTarget = 'target-current';
    const staleTarget = target.runTargetControl('target_restart', {});
    await target.flush();
    expect(target.calls).toHaveLength(4);
    target.disconnect();
    target.resolveLoad(0, 'A');
    await staleTarget;
    expect(target.renderTargetsCount()).toBe(0);

    const navigated = createHarness();
    navigated.state.selectedTarget = 'target-current';
    const away = navigated.runTargetControl('target_restart', {});
    await navigated.flush();
    expect(navigated.calls).toHaveLength(4);
    navigated.location.hash = '#/overview';
    navigated.resolveLoad(0, 'CURRENT');
    await away;
    expect(navigated.renderTargetsCount()).toBe(0);

    // Static structure binds the production implementation to the same lifecycle contract.
    const stateSource = text.match(/const state = \{([\s\S]*?)\n\};/)?.[1];
    expect(stateSource).toContain('coreDataEpoch: 0');
    expect(stateSource).toContain('coreDataRequestVersion: 0');
    expect(loadCoreDataSource).toContain('const epoch = state.coreDataEpoch;');
    expect(loadCoreDataSource).toContain('const version = ++state.coreDataRequestVersion;');
    expect(loadCoreDataSource).toContain('if (!state.connected || state.coreDataEpoch !== epoch || state.coreDataRequestVersion !== version) return false;');
    expect(loadCoreDataSource).toContain('return true;');
    expect(disconnectSource).toContain('state.coreDataEpoch += 1;');
    expect(refreshSource).toContain('state.coreDataEpoch += 1;');
    expect(refreshSource).toContain('const coreDataCommitted = await loadCoreData();');
    expect(refreshSource).toContain('if (!coreDataCommitted) return;');
    expect(targetControlSource).toContain('const coreDataCommitted = await loadCoreData();');
    expect(targetControlSource).toContain("if (!coreDataCommitted || currentRoute() !== 'targets') return;");
    expect(connectSubmitBody).toContain('const coreDataCommitted = await loadCoreData();');
    expect(connectSubmitBody).toContain('if (!coreDataCommitted) return;');
  });

  it('coordinates overlapping core-data loads through the real safeCall path', async () => {
    const text = app();
    const loadCoreDataSource = text.match(/async function loadCoreData\(\) \{[\s\S]*?\n\}\n/)?.[0];
    const safeCallSource = text.match(/async function safeCall\(name, args, \{ silent = false, throwOnError = false \} = \{\}\) \{[\s\S]*?\n\}\n/)?.[0];
    const disconnectSource = text.match(/function disconnect\(\) \{[\s\S]*?\n\}\n/)?.[0];
    expect(loadCoreDataSource).toBeTruthy();
    expect(safeCallSource).toBeTruthy();
    expect(disconnectSource).toBeTruthy();

    const createDeferred = () => {
      let resolve!: (value: any) => void;
      let reject!: (reason: any) => void;
      const promise = new Promise<any>((done, fail) => { resolve = done; reject = fail; });
      return { promise, resolve, reject };
    };
    const state: Record<string, any> = {
      connected: true,
      serverTools: [{ name: 'control_center_query' }],
      targets: [{ id: 'target-PREVIOUS', running: true }],
      targetDetails: new Map(), backends: [{ id: 'backend-PREVIOUS', available: true }], projects: [{ id: 'project-PREVIOUS' }], jobs: new Map(),
      deniedTools: new Map(), selectedTarget: 'target-PREVIOUS', selectedJobId: '', toolResults: new Map(), routeResults: new Map(),
      pending: new Set(), pendingRequestOwners: new Map(), pendingRequestVersion: 0, connectionEpoch: 0,
      chatMessages: [], chatJobId: '', chatPollingController: null,
      chatConfig: { backend: 'backend-PREVIOUS', project: 'project-PREVIOUS', profile: 'audit', resourcePolicy: 'standard' },
      controlCenter: new Map([['summary', { marker: 'PREVIOUS' }]]), controlCenterEpoch: 0, controlCenterRequestVersions: new Map(),
      coreDataEpoch: 0, coreDataRequestVersion: 0, coreDataActivePromise: null,
      githubRepositories: [], githubLoaded: false, selectedGithubRepository: '',
    };
    const physicalCalls: Array<{ name: string; args: any; deferred: ReturnType<typeof createDeferred> }> = [];
    class McpClientError extends Error { status?: number; code?: string; constructor(message: string, details: Record<string, any> = {}) { super(message); Object.assign(this, details); } }
    const client = {
      clearCredential() {},
      callTool(name: string, args: any) { const deferred = createDeferred(); physicalCalls.push({ name, args, deferred }); return deferred.promise; },
    };
    const context: Record<string, any> = {
      state, client, McpClientError,
      serverHasTool: (name: string) => name === 'control_center_query' && state.serverTools.some((tool: any) => tool.name === name),
      toast: () => {}, errorMessage: (error: any) => error?.message ?? String(error),
      app: { dataset: { connected: 'true' } }, connectionLabel: { textContent: 'Connected' }, disconnectButton: { hidden: false, disabled: false },
      location: { hash: '#/overview' }, announce: () => {},
    };
    runInNewContext([safeCallSource, loadCoreDataSource, disconnectSource,
      'globalThis.__loadCoreData = loadCoreData;'].join('\n'), context);
    const loadCoreData = context.__loadCoreData as () => Promise<boolean>;
    const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
    const resolveGroup = (start: number, marker: string) => {
      const group = physicalCalls.slice(start, start + 4);
      expect(group).toHaveLength(4);
      for (const entry of group) {
        if (entry.name === 'targets_list') entry.deferred.resolve({ targets: [{ id: `target-${marker}`, running: true }] });
        else if (entry.name === 'agents_list') entry.deferred.resolve({ backends: [{ id: `backend-${marker}`, available: true }] });
        else if (entry.name === 'agent_projects') entry.deferred.resolve({ projects: [{ id: `project-${marker}` }] });
        else if (entry.name === 'control_center_query') entry.deferred.resolve({ data: { marker } });
      }
    };

    const oldLoad = loadCoreData();
    expect(physicalCalls).toHaveLength(4);
    let newSettled = false;
    let newResult: boolean | undefined;
    const newLoad = loadCoreData().then((value) => { newSettled = true; newResult = value; return value; });
    await flush();

    // A newer logical load must wait/rerun rather than claim success from duplicate-null safeCall results.
    expect({
      newSettled,
      newResult,
      physicalCallCount: physicalCalls.length,
      targets: state.targets.map((entry: any) => entry.id),
      backends: state.backends.map((entry: any) => entry.id),
      projects: state.projects.map((entry: any) => entry.id),
      summary: state.controlCenter.get('summary')?.marker,
    }).toEqual({
      newSettled: false,
      newResult: undefined,
      physicalCallCount: 4,
      targets: ['target-PREVIOUS'],
      backends: ['backend-PREVIOUS'],
      projects: ['project-PREVIOUS'],
      summary: 'PREVIOUS',
    });

    resolveGroup(0, 'OLD');
    expect(await oldLoad).toBe(false);
    await flush();
    expect(physicalCalls).toHaveLength(8);
    resolveGroup(4, 'NEW');
    expect(await newLoad).toBe(true);
    expect(state.controlCenter.get('summary')).toEqual({ marker: 'NEW' });
    expect(state.targets.map((entry: any) => entry.id)).toEqual(['target-NEW']);
    expect(state.backends.map((entry: any) => entry.id)).toEqual(['backend-NEW']);
    expect(state.projects.map((entry: any) => entry.id)).toEqual(['project-NEW']);
  });

  it('prevents a stale Principal-A 401 from disconnecting a newer Principal-B lifecycle', async () => {
    const text = app();
    const loadCoreDataSource = text.match(/async function loadCoreData\(\) \{[\s\S]*?\n\}\n/)?.[0];
    const safeCallSource = text.match(/async function safeCall\(name, args, \{ silent = false, throwOnError = false \} = \{\}\) \{[\s\S]*?\n\}\n/)?.[0];
    const disconnectSource = text.match(/function disconnect\(\) \{[\s\S]*?\n\}\n/)?.[0];
    expect(loadCoreDataSource).toBeTruthy(); expect(safeCallSource).toBeTruthy(); expect(disconnectSource).toBeTruthy();
    const createDeferred = () => { let resolve!: (value:any)=>void; let reject!: (reason:any)=>void; const promise=new Promise<any>((done,fail)=>{resolve=done;reject=fail;}); return {promise,resolve,reject}; };
    const state: Record<string, any> = {
      connected:true, serverTools:[{name:'control_center_query'}], targets:[], targetDetails:new Map(), backends:[], projects:[], jobs:new Map(), deniedTools:new Map(),
      selectedTarget:'', selectedJobId:'', toolResults:new Map(), routeResults:new Map(), pending:new Set(), pendingRequestOwners:new Map(), pendingRequestVersion:0, connectionEpoch:0,
      chatMessages:[], chatJobId:'', chatPollingController:null, chatConfig:{backend:'',project:'',profile:'audit',resourcePolicy:'standard'},
      controlCenter:new Map(), controlCenterEpoch:0, controlCenterRequestVersions:new Map(), coreDataEpoch:0, coreDataRequestVersion:0, coreDataActivePromise:null,
      githubRepositories:[], githubLoaded:false, selectedGithubRepository:'',
    };
    const calls:Array<{name:string; deferred:ReturnType<typeof createDeferred>}> = [];
    let clearCredentialCount=0;
    class McpClientError extends Error { status?:number; code?:string; constructor(message:string, details:Record<string,any>={}) { super(message); Object.assign(this,details); } }
    const client={ clearCredential(){clearCredentialCount+=1;}, callTool(name:string,_args:any){const deferred=createDeferred();calls.push({name,deferred});return deferred.promise;} };
    const location={hash:'#/overview'};
    const context:Record<string,any>={ state,client,McpClientError,serverHasTool:(name:string)=>name==='control_center_query'&&state.serverTools.some((tool:any)=>tool.name===name),toast:()=>{},errorMessage:(e:any)=>e?.message??String(e),app:{dataset:{connected:'true'}},connectionLabel:{textContent:'Connected'},disconnectButton:{hidden:false,disabled:false},location,announce:()=>{} };
    runInNewContext([safeCallSource,loadCoreDataSource,disconnectSource,'globalThis.__loadCoreData=loadCoreData;globalThis.__disconnect=disconnect;'].join('\n'),context);
    const loadCoreData=context.__loadCoreData as ()=>Promise<boolean>; const disconnect=context.__disconnect as ()=>void;
    const resolveGroup=(start:number,marker:string)=>{for(const entry of calls.slice(start,start+4)){if(entry.name==='targets_list')entry.deferred.resolve({targets:[{id:`target-${marker}`}]});else if(entry.name==='agents_list')entry.deferred.resolve({backends:[{id:`backend-${marker}`,available:true}]});else if(entry.name==='agent_projects')entry.deferred.resolve({projects:[{id:`project-${marker}`}]});else entry.deferred.resolve({data:{marker}});}};

    const principalA=loadCoreData();
    expect(calls).toHaveLength(4);
    disconnect();
    expect(clearCredentialCount).toBe(1);
    state.connected=true; state.serverTools=[{name:'control_center_query'}]; location.hash='#/overview';
    const principalB=loadCoreData();
    expect(calls).toHaveLength(8);
    resolveGroup(4,'B');
    expect(await principalB).toBe(true);
    expect(state.connected).toBe(true);
    expect(state.controlCenter.get('summary')).toEqual({marker:'B'});

    calls[0].deferred.reject(new McpClientError('old credential rejected',{status:401,code:'UNAUTHORIZED'}));
    for (const entry of calls.slice(1,4)) entry.deferred.resolve(entry.name==='agents_list'?{backends:[]}:entry.name==='agent_projects'?{projects:[]}:entry.name==='control_center_query'?{data:{marker:'A'}}:{targets:[]});
    expect(await principalA).toBe(false);
    expect(state.connected).toBe(true);
    expect(clearCredentialCount).toBe(1);
    expect(location.hash).toBe('#/overview');
    expect(state.controlCenter.get('summary')).toEqual({marker:'B'});
    expect(state.targets.map((entry:any)=>entry.id)).toEqual(['target-B']);
  });

  it('keeps newer same-key pending ownership and denial metadata safe from stale completion', async () => {
    const text = app();
    const safeCallSource = text.match(/async function safeCall\(name, args, \{ silent = false, throwOnError = false \} = \{\}\) \{[\s\S]*?\n\}\n/)?.[0];
    const disconnectSource = text.match(/function disconnect\(\) \{[\s\S]*?\n\}\n/)?.[0];
    expect(safeCallSource).toBeTruthy(); expect(disconnectSource).toBeTruthy();
    const createDeferred=()=>{let resolve!:(value:any)=>void;let reject!:(reason:any)=>void;const promise=new Promise<any>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
    const state:Record<string,any>={connected:true,serverTools:[],targets:[],targetDetails:new Map(),backends:[],projects:[],jobs:new Map(),deniedTools:new Map(),selectedTarget:'',selectedJobId:'',toolResults:new Map(),routeResults:new Map(),pending:new Set(),pendingRequestOwners:new Map(),pendingRequestVersion:0,connectionEpoch:0,chatMessages:[],chatJobId:'',chatPollingController:null,chatConfig:{backend:'',project:'',profile:'audit',resourcePolicy:'standard'},controlCenter:new Map(),controlCenterEpoch:0,controlCenterRequestVersions:new Map(),coreDataEpoch:0,coreDataRequestVersion:0,coreDataActivePromise:null,githubRepositories:[],githubLoaded:false,selectedGithubRepository:''};
    const calls:Array<{name:string;deferred:ReturnType<typeof createDeferred>}>=[];
    class McpClientError extends Error {status?:number;code?:string;constructor(message:string,details:Record<string,any>={}){super(message);Object.assign(this,details);}}
    const client={clearCredential(){},callTool(name:string,_args:any){const deferred=createDeferred();calls.push({name,deferred});return deferred.promise;}};
    const context:Record<string,any>={state,client,McpClientError,toast:()=>{},errorMessage:(e:any)=>e?.message??String(e),app:{dataset:{connected:'true'}},connectionLabel:{textContent:'Connected'},disconnectButton:{hidden:false,disabled:false},location:{hash:'#/overview'},announce:()=>{}};
    runInNewContext([safeCallSource,disconnectSource,'globalThis.__safeCall=safeCall;globalThis.__disconnect=disconnect;'].join('\n'),context);
    const safeCall=context.__safeCall as (name:string,args:any,opts?:any)=>Promise<any>; const disconnect=context.__disconnect as ()=>void;

    const oldSuccess=safeCall('targets_list',{}, {silent:true});
    expect(state.pending.has('targets_list:{}')).toBe(true);
    disconnect(); state.connected=true;
    state.deniedTools.set('targets_list','B-DENIAL');
    const newRequest=safeCall('targets_list',{}, {silent:true});
    expect(calls).toHaveLength(2);
    expect(state.pending.has('targets_list:{}')).toBe(true);
    calls[0].deferred.resolve({targets:[{id:'A'}]});
    await oldSuccess;
    expect(state.pending.has('targets_list:{}')).toBe(true);
    expect(state.deniedTools.get('targets_list')).toBe('B-DENIAL');

    const third=safeCall('targets_list',{}, {silent:true});
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    expect(await third).toBeNull();
    calls[1].deferred.resolve({targets:[{id:'B'}]});
    await newRequest;
    expect(state.pending.has('targets_list:{}')).toBe(false);

    const oldForbidden=safeCall('agents_list',{}, {silent:true});
    disconnect(); state.connected=true;
    state.deniedTools.set('agents_list','B-CURRENT');
    const newAgents=safeCall('agents_list',{}, {silent:true});
    expect(calls).toHaveLength(4);
    calls[2].deferred.reject(new McpClientError('A forbidden',{status:403,code:'FORBIDDEN_TOOL'}));
    await oldForbidden;
    expect(state.deniedTools.get('agents_list')).toBe('B-CURRENT');
    calls[3].deferred.resolve({backends:[{id:'B'}]});
    await newAgents;
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
