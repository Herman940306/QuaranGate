import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectVsCodeWorkspacePhysicalIdentity,
  VsCodeWorkspaceCollectorError,
  type VsCodeWorkspaceSnapshot,
} from '../../src/ide-adapters/vscode/vscodeWorkspaceCollector.js';

const roots: string[] = [];
const HEAD = 'a'.repeat(40);

function root(): string {
  const value = mkdtempSync(join(process.cwd(), '.qg-vscode-workspace-'));
  roots.push(value);
  return value;
}

function machineId(base: string, value = '1'.repeat(32)): string {
  const path = join(base, 'machine-id');
  writeFileSync(path, `${value}\n`, 'utf8');
  return path;
}

function snapshot(workspace: string, over: Partial<VsCodeWorkspaceSnapshot> = {}): VsCodeWorkspaceSnapshot {
  return {
    remoteName: 'wsl',
    extensionHostKind: 'workspace',
    workspaceFolders: [{ uri: pathToFileURL(workspace).href, fsPath: workspace, scheme: 'file' }],
    ...over,
  };
}

function makeOrdinaryGit(workspace: string): string {
  const dot = join(workspace, '.git');
  mkdirSync(join(dot, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dot, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dot, 'refs', 'heads', 'main'), `${HEAD}\n`);
  return dot;
}

function code(error: unknown): string {
  if (error instanceof VsCodeWorkspaceCollectorError) return error.code;
  throw error;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('P7 I2.1 VS Code Remote-WSL workspace evidence collector', () => {
  it('collects exact case-sensitive WSL + ordinary Git identity without shell commands', async () => {
    const base = root();
    const workspace = join(base, 'workspace');
    mkdirSync(workspace);
    const dotGit = makeOrdinaryGit(workspace);
    const result = await collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace), { machineIdPath: machineId(base) });
    expect(result).toMatchObject({
      workspaceFolderCount: 1,
      remoteKind: 'wsl',
      pathFlavor: 'posix',
      caseMode: 'case-sensitive',
      canonicalization: 'realpath-exact',
      workspaceUri: pathToFileURL(workspace).href,
      canonicalPath: workspace,
    });
    expect(result.environmentIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(result.filesystemIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(result.git).toMatchObject({ kind: 'worktree', worktreeRoot: workspace, commonDir: dotGit, headRevision: HEAD });
    if (result.git.kind === 'worktree') expect(result.git.commonDirIdentity).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves linked-worktree gitdir + commondir and pins the common repository identity', async () => {
    const base = root();
    const workspace = join(base, 'worktree');
    const common = join(base, 'repo.git');
    const gitDir = join(common, 'worktrees', 'worktree');
    mkdirSync(workspace);
    mkdirSync(join(common, 'refs', 'heads'), { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(workspace, '.git'), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(common, 'refs', 'heads', 'main'), `${HEAD}\n`);
    const result = await collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace), { machineIdPath: machineId(base) });
    expect(result.git).toMatchObject({ kind: 'worktree', worktreeRoot: workspace, commonDir: common, headRevision: HEAD });
  });

  it('allows a non-Git workspace only as explicit git:none evidence', async () => {
    const base = root(); const workspace = join(base, 'workspace'); mkdirSync(workspace);
    const result = await collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace), { machineIdPath: machineId(base) });
    expect(result.git).toEqual({ kind: 'none' });
  });

  it('fails closed outside Remote-WSL workspace-host placement or with multi-root ambiguity', async () => {
    const base = root(); const workspace = join(base, 'workspace'); mkdirSync(workspace); const id = machineId(base);
    await expect(collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace, { remoteName: 'ssh-remote' }), { machineIdPath: id }))
      .rejects.toMatchObject({ code: 'VSCODE_WORKSPACE_HOST_DENIED' });
    await expect(collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace, { extensionHostKind: 'ui' }), { machineIdPath: id }))
      .rejects.toMatchObject({ code: 'VSCODE_WORKSPACE_HOST_DENIED' });
    const folder = { uri: pathToFileURL(workspace).href, fsPath: workspace, scheme: 'file' };
    await expect(collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace, { workspaceFolders: [folder, folder] }), { machineIdPath: id }))
      .rejects.toMatchObject({ code: 'VSCODE_WORKSPACE_AMBIGUOUS' });
  });

  it('rejects URI/path aliases and symlink workspace paths rather than canonicalizing them into authority', async () => {
    const base = root(); const workspace = join(base, 'workspace'); mkdirSync(workspace); const id = machineId(base);
    const alias = join(base, 'alias'); symlinkSync(workspace, alias);
    await expect(collectVsCodeWorkspacePhysicalIdentity(snapshot(alias), { machineIdPath: id }))
      .rejects.toMatchObject({ code: 'VSCODE_WORKSPACE_PATH_DENIED' });
    const bad = snapshot(workspace, { workspaceFolders: [{ uri: `${pathToFileURL(workspace).href}/`, fsPath: workspace, scheme: 'file' }] });
    await expect(collectVsCodeWorkspacePhysicalIdentity(bad, { machineIdPath: id }))
      .rejects.toMatchObject({ code: 'VSCODE_WORKSPACE_PATH_DENIED' });
  });

  it('rejects malformed WSL machine identity instead of weakening environment binding', async () => {
    const base = root(); const workspace = join(base, 'workspace'); mkdirSync(workspace);
    await expect(collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace), { machineIdPath: machineId(base, 'not-a-machine-id') }))
      .rejects.toMatchObject({ code: 'VSCODE_WORKSPACE_ENVIRONMENT_DENIED' });
  });

  it('rejects uppercase/noncanonical machine identity rather than normalizing evidence', async () => {
    const base = root(); const workspace = join(base, 'workspace'); mkdirSync(workspace);
    await expect(collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace), { machineIdPath: machineId(base, 'A'.repeat(32)) }))
      .rejects.toMatchObject({ code: 'VSCODE_WORKSPACE_ENVIRONMENT_DENIED' });
  });

  it('rejects uppercase/noncanonical Git revision evidence', async () => {
    const base = root(); const workspace = join(base, 'workspace'); mkdirSync(workspace); const id = machineId(base);
    const dot = join(workspace, '.git'); mkdirSync(join(dot, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dot, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dot, 'refs', 'heads', 'main'), `${'A'.repeat(40)}\n`);
    await expect(collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace), { machineIdPath: id }))
      .rejects.toMatchObject({ code: 'VSCODE_WORKSPACE_GIT_DENIED' });
  });

  it('rejects unresolved or malformed Git HEAD evidence instead of downgrading it to git:none', async () => {
    const base = root(); const workspace = join(base, 'workspace'); mkdirSync(workspace); const id = machineId(base);
    mkdirSync(join(workspace, '.git'));
    writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/missing\n');
    await expect(collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace), { machineIdPath: id }))
      .rejects.toMatchObject({ code: 'VSCODE_WORKSPACE_GIT_DENIED' });
  });

  it('surfaces collector error codes as stable bounded categories', async () => {
    const base = root(); const workspace = join(base, 'workspace'); mkdirSync(workspace);
    try {
      await collectVsCodeWorkspacePhysicalIdentity(snapshot(workspace), { machineIdPath: join(base, 'missing-machine-id') });
      throw new Error('expected collector error');
    } catch (error) {
      expect(code(error)).toBe('VSCODE_WORKSPACE_ENVIRONMENT_DENIED');
    }
  });
});
