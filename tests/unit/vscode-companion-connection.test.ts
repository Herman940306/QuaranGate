import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveIdeEnvironmentIdentity,
  deriveIdeFilesystemIdentity,
  deriveIdeWorkspaceFingerprint,
  type IdeWorkspacePhysicalIdentity,
} from '../../src/shared/ideWorkspaceAttestation.js';
import { IdeSessionStore } from '../../src/executor/ide/ideSessionStore.js';
import { createIdeCompanionRuntime, type IdeCompanionRuntimeRef } from '../../src/executor/ide/ideCompanionRuntime.js';
import { IdeCompanionListener } from '../../src/executor/ide/ideCompanionListener.js';
import { readVsCodeCompanionCredential } from '../../src/ide-adapters/vscode/vscodeCompanionCredential.js';
import {
  connectVsCodeCompanion,
  type VsCodeCompanionConnection,
} from '../../src/ide-adapters/vscode/vscodeCompanionConnection.js';

const NOW = 1_800_000_000_000;
const BASE = 'a'.repeat(40);
const roots: string[] = [];
let store: IdeSessionStore | undefined;
let listener: IdeCompanionListener | undefined;
let connection: VsCodeCompanionConnection | undefined;
let seq = 0;

function physical(over: Partial<IdeWorkspacePhysicalIdentity> = {}): IdeWorkspacePhysicalIdentity {
  const canonicalPath = '/srv/projects/quarangate-forward';
  return {
    workspaceFolderCount: 1,
    remoteKind: 'wsl',
    environmentIdentity: deriveIdeEnvironmentIdentity('wsl', 'ubuntu-24.04:stable-id'),
    pathFlavor: 'posix',
    caseMode: 'case-sensitive',
    canonicalization: 'realpath-exact',
    workspaceUri: pathToFileURL(canonicalPath).href,
    canonicalPath,
    filesystemIdentity: deriveIdeFilesystemIdentity('posix', '100', '200'),
    git: {
      kind: 'worktree',
      worktreeRoot: canonicalPath,
      commonDir: '/srv/projects/QuaranGate/.git',
      commonDirIdentity: deriveIdeFilesystemIdentity('posix', '100', '300'),
      headRevision: BASE,
    },
    ...over,
  };
}

function fixture(workspace = physical()): { runtime: IdeCompanionRuntimeRef; workspace: IdeWorkspacePhysicalIdentity } {
  seq += 1;
  const dbBase = mkdtempSync(join(tmpdir(), 'qg-vsc-conn-db-')); roots.push(dbBase);
  store = new IdeSessionStore(join(dbBase, 'ide.db'));
  const runtimeBase = mkdtempSync(join(tmpdir(), 'qg-vsc-conn-')); roots.push(runtimeBase); chmodSync(runtimeBase, 0o700);
  const runtimeRoot = join(runtimeBase, 'runtime'); mkdirSync(runtimeRoot, { mode: 0o700 }); chmodSync(runtimeRoot, 0o700);
  const digit = (seq % 15 + 1).toString(16);
  const fingerprint = deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace });
  const enrollment = store.createEnrollment({
    principalId: 'chatgpt-browser',
    projectId: 'quarangate',
    worktreeId: 'forward',
    ideProduct: 'vscode',
    ideInstanceId: `ide_${digit.repeat(32)}`,
    workspaceFingerprint: fingerprint,
    baseRevision: BASE,
    capabilities: ['prompt', 'cancel', 'observe_response', 'request_review'],
  });
  const runtime = createIdeCompanionRuntime({
    runtimeRoot,
    enrollmentId: enrollment.enrollmentId,
    ideInstanceId: enrollment.ideInstanceId,
    ideProduct: 'vscode',
    adapterVersion: '1.2.3',
  });
  listener = new IdeCompanionListener({
    store,
    runtime,
    nowMs: () => NOW,
    challengeBytes: () => Buffer.alloc(32, 0x42),
  });
  return { runtime, workspace };
}

function deterministicRandom(size: number): Buffer {
  return Buffer.alloc(size, size === 16 ? 0x51 : 0x52);
}

async function waitFor(fn: () => boolean, timeoutMs = 300): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  connection?.close(); connection = undefined;
  if (listener !== undefined) await listener.stop().catch(() => undefined);
  listener = undefined;
  store?.close(); store = undefined;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('P7 I2.1 VS Code production client -> accepted B6 listener', () => {
  it('uses the exact B4/B5/B6 chain to make one enrolled VS Code workspace AVAILABLE and zeroes bootstrap secret material', async () => {
    const ctx = fixture(); await listener!.start();
    const credential = readVsCodeCompanionCredential(ctx.runtime.credentialPath, ctx.runtime.adapterVersion);
    connection = await connectVsCodeCompanion({
      credential,
      workspace: ctx.workspace,
      nowMs: () => NOW,
      randomBytes: deterministicRandom,
    });
    expect(connection.sessionId).toBe(`ides_${'51'.repeat(16)}`);
    expect(connection.connectionGeneration).toBe(1);
    expect(store!.getSession(connection.sessionId)).toMatchObject({ state: 'AVAILABLE', connectionGeneration: 1 });
    expect(credential.secret.equals(Buffer.alloc(32))).toBe(true);
    expect(Object.keys(connection).sort()).toEqual(['close', 'connectionGeneration', 'sessionId', 'socket'].sort());
  });

  it('closing the authenticated client reconciles the current Plane-B session to DISCONNECTED', async () => {
    const ctx = fixture(); await listener!.start();
    const credential = readVsCodeCompanionCredential(ctx.runtime.credentialPath, ctx.runtime.adapterVersion);
    connection = await connectVsCodeCompanion({ credential, workspace: ctx.workspace, nowMs: () => NOW, randomBytes: deterministicRandom });
    const sid = connection.sessionId;
    connection.close(); connection = undefined;
    await waitFor(() => store!.getSession(sid)?.state === 'DISCONNECTED');
    expect(store!.getSession(sid)?.state).toBe('DISCONNECTED');
  });

  it('rejects socket permission drift before sending any handshake frame', async () => {
    const ctx = fixture(); await listener!.start();
    chmodSync(ctx.runtime.socketPath, 0o660);
    const credential = readVsCodeCompanionCredential(ctx.runtime.credentialPath, ctx.runtime.adapterVersion);
    await expect(connectVsCodeCompanion({ credential, workspace: ctx.workspace, nowMs: () => NOW, randomBytes: deterministicRandom }))
      .rejects.toMatchObject({ code: 'VSCODE_CONNECTION_FAILED' });
    expect(credential.secret.equals(Buffer.alloc(32))).toBe(false);
    credential.secret.fill(0);
  });

  it('authenticated physical workspace drift never becomes AVAILABLE', async () => {
    const trusted = physical(); const ctx = fixture(trusted); await listener!.start();
    const credential = readVsCodeCompanionCredential(ctx.runtime.credentialPath, ctx.runtime.adapterVersion);
    const drifted = physical({ filesystemIdentity: 'f'.repeat(64) });
    await expect(connectVsCodeCompanion({ credential, workspace: drifted, nowMs: () => NOW, randomBytes: deterministicRandom }))
      .rejects.toBeDefined();
    expect(credential.secret.equals(Buffer.alloc(32))).toBe(true);
    const sid = `ides_${'51'.repeat(16)}`;
    await waitFor(() => store!.getSession(sid)?.state === 'DISCONNECTED');
    expect(store!.getSession(sid)?.state).toBe('DISCONNECTED');
  });

  it('does not grant a controller or start operation authority as part of the production identity handshake', async () => {
    const ctx = fixture(); await listener!.start();
    const credential = readVsCodeCompanionCredential(ctx.runtime.credentialPath, ctx.runtime.adapterVersion);
    connection = await connectVsCodeCompanion({ credential, workspace: ctx.workspace, nowMs: () => NOW, randomBytes: deterministicRandom });
    const session = store!.getSession(connection.sessionId)!;
    expect(session.state).toBe('AVAILABLE');
    expect(session.controllerLeaseId).toBeNull();
    expect(store!.schemaVersion).toBe(4);
  });
});
