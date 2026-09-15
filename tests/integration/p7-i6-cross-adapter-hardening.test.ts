import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { startIdeCompanionProduction } from '../../src/executor/ide/ideCompanionProduction.js';
import { IdeSessionStore, type IdeEnrollmentRow, type IdeSessionRegistryRow } from '../../src/executor/ide/ideSessionStore.js';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { readVsCodeCompanionCredential } from '../../src/ide-adapters/vscode/vscodeCompanionCredential.js';
import { readCursorCompanionCredential } from '../../src/ide-adapters/cursor/cursorCompanionCredential.js';

const roots: string[] = [];
const principalId = 'chatgpt-browser';
const projectId = 'quarangate';
const worktreeId = 'forward';
const workspaceFingerprint = 'a'.repeat(64);
const baseRevision = 'b'.repeat(40);
const capabilities = ['prompt', 'cancel', 'observe_response', 'request_review'] as const;

function tempRoot(prefix = 'qg-i6-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function productionLayout() {
  const base = tempRoot();
  const runtimeRoot = join(base, 'runtime');
  const jobs = join(base, 'jobs');
  mkdirSync(runtimeRoot, { mode: 0o700 });
  mkdirSync(jobs, { mode: 0o700 });
  chmodSync(runtimeRoot, 0o700);
  chmodSync(jobs, 0o700);
  return {
    base,
    runtimeRoot,
    databasePath: join(jobs, 'ide-sessions.db'),
    configPath: join(base, 'ide-sessions.yaml'),
  };
}

function trustedEnrollment(product: 'vscode' | 'cursor') {
  const cursor = product === 'cursor';
  return {
    principalId,
    projectId,
    worktreeId,
    ideProduct: product,
    ideInstanceId: `ide_${(cursor ? 'c' : 'a').repeat(32)}`,
    workspaceFingerprint,
    baseRevision,
    capabilities: [...capabilities],
    adapterVersion: '0.1.0',
    runtimeInstanceId: `iderun_${(cursor ? 'c' : 'd').repeat(32)}`,
  };
}

function writeDualConfig(path: string): void {
  writeFileSync(path, YAML.stringify({
    version: 1,
    enrollments: [trustedEnrollment('vscode'), trustedEnrollment('cursor')],
  }), { mode: 0o600 });
}

function enrollment(product: 'vscode' | 'cursor') {
  const cursor = product === 'cursor';
  return {
    principalId,
    projectId,
    worktreeId,
    ideProduct: product,
    ideInstanceId: `ide_${(cursor ? '3' : '1').repeat(32)}`,
    workspaceFingerprint,
    baseRevision,
    capabilities: [...capabilities],
  } as const;
}

function enrollmentKey(row: IdeEnrollmentRow) {
  return {
    enrollmentId: row.enrollmentId,
    principalId: row.principalId,
    projectId: row.projectId,
    worktreeId: row.worktreeId,
    ideProduct: row.ideProduct,
    ideInstanceId: row.ideInstanceId,
    workspaceFingerprint: row.workspaceFingerprint,
    baseRevision: row.baseRevision,
  };
}

function sessionKey(row: IdeEnrollmentRow, session: IdeSessionRegistryRow) {
  return {
    principalId: row.principalId,
    projectId: row.projectId,
    worktreeId: row.worktreeId,
    ideProduct: row.ideProduct,
    ideInstanceId: row.ideInstanceId,
    workspaceFingerprint: row.workspaceFingerprint,
    baseRevision: row.baseRevision,
    sessionId: session.sessionId,
    connectionGeneration: session.connectionGeneration,
  };
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'OTHER_ERROR';
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('P7 I6 cross-adapter hardening', () => {
  it('starts VS Code and Cursor as distinct review-only runtimes without sharing credentials or sockets', async () => {
    const l = productionLayout();
    writeDualConfig(l.configPath);
    const runtime = await startIdeCompanionProduction({
      configPath: l.configPath,
      databasePath: l.databasePath,
      runtimeRoot: l.runtimeRoot,
    });

    expect(runtime.state).toBe('AVAILABLE_NOT_LIVE_QUALIFIED');
    expect(runtime.bootstrapBindings).toHaveLength(2);
    const byInstance = new Map(runtime.bootstrapBindings.map((binding) => [binding.ideInstanceId, binding]));
    const vscodeBinding = byInstance.get(trustedEnrollment('vscode').ideInstanceId)!;
    const cursorBinding = byInstance.get(trustedEnrollment('cursor').ideInstanceId)!;
    expect(vscodeBinding.runtimeInstanceId).not.toBe(cursorBinding.runtimeInstanceId);
    expect(vscodeBinding.credentialPath).not.toBe(cursorBinding.credentialPath);

    const vscodeRaw = JSON.parse(readFileSync(vscodeBinding.credentialPath, 'utf8')) as Record<string, unknown>;
    const cursorRaw = JSON.parse(readFileSync(cursorBinding.credentialPath, 'utf8')) as Record<string, unknown>;
    expect(vscodeRaw).toMatchObject({ ideProduct: 'vscode', adapterId: 'quarangate-vscode-companion' });
    expect(cursorRaw).toMatchObject({ ideProduct: 'cursor', adapterId: 'quarangate-cursor-companion' });
    expect(JSON.stringify(vscodeRaw)).not.toContain('request_implementation');
    expect(JSON.stringify(cursorRaw)).not.toContain('request_implementation');

    const vscodeSocket = join(l.runtimeRoot, vscodeBinding.runtimeInstanceId, 'companion.sock');
    const cursorSocket = join(l.runtimeRoot, cursorBinding.runtimeInstanceId, 'companion.sock');
    expect(existsSync(vscodeSocket)).toBe(true);
    expect(existsSync(cursorSocket)).toBe(true);
    await runtime.stop();
    expect(existsSync(vscodeSocket)).toBe(false);
    expect(existsSync(cursorSocket)).toBe(false);
    expect(existsSync(vscodeBinding.credentialPath)).toBe(true);
    expect(existsSync(cursorBinding.credentialPath)).toBe(true);
  });

  it('refuses cross-product credential reuse even though both products share the common runtime contract', async () => {
    const l = productionLayout();
    writeDualConfig(l.configPath);
    const runtime = await startIdeCompanionProduction({
      configPath: l.configPath,
      databasePath: l.databasePath,
      runtimeRoot: l.runtimeRoot,
    });
    const byInstance = new Map(runtime.bootstrapBindings.map((binding) => [binding.ideInstanceId, binding]));
    const vscodeCredential = byInstance.get(trustedEnrollment('vscode').ideInstanceId)!.credentialPath;
    const cursorCredential = byInstance.get(trustedEnrollment('cursor').ideInstanceId)!.credentialPath;

    expect(() => readVsCodeCompanionCredential(vscodeCredential, '0.1.0')).not.toThrow();
    expect(() => readCursorCompanionCredential(cursorCredential, '0.1.0')).not.toThrow();
    expect(() => readVsCodeCompanionCredential(cursorCredential, '0.1.0')).toThrow();
    expect(() => readCursorCompanionCredential(vscodeCredential, '0.1.0')).toThrow();
    await runtime.stop();
  });

  it('keeps generation and reconnect state independent across products on one logical worktree', () => {
    const root = tempRoot();
    const store = new IdeSessionStore(join(root, 'ide.db'));
    const vscode = store.createEnrollment(enrollment('vscode'));
    const cursor = store.createEnrollment(enrollment('cursor'));
    const vscode1 = store.openSession({ ...enrollmentKey(vscode), sessionId: `ides_${'1'.repeat(32)}` });
    const cursor1 = store.openSession({ ...enrollmentKey(cursor), sessionId: `ides_${'2'.repeat(32)}` });
    store.markAvailable(sessionKey(vscode, vscode1));
    store.markAvailable(sessionKey(cursor, cursor1));

    const vscode2 = store.openSession({
      ...enrollmentKey(store.getEnrollment(vscode.enrollmentId)!),
      sessionId: `ides_${'3'.repeat(32)}`,
    });
    expect(vscode2.connectionGeneration).toBe(2);
    expect(store.getSession(vscode1.sessionId)?.state).toBe('STALE');
    expect(store.getSession(cursor1.sessionId)?.state).toBe('AVAILABLE');
    expect(store.getEnrollment(cursor.enrollmentId)?.currentGeneration).toBe(1);
    expect(store.getEnrollment(vscode.enrollmentId)?.currentGeneration).toBe(2);
    store.close();
  });

  it('denies cross-product session substitution before it can advance generation or authority', () => {
    const root = tempRoot();
    const store = new IdeSessionStore(join(root, 'ide.db'));
    const vscode = store.createEnrollment(enrollment('vscode'));
    const cursor = store.createEnrollment(enrollment('cursor'));
    expect(errorCode(() => store.openSession({
      ...enrollmentKey(vscode),
      ideProduct: 'cursor',
      ideInstanceId: cursor.ideInstanceId,
      sessionId: `ides_${'4'.repeat(32)}`,
    }))).toBe('IDE_ENROLLMENT_BINDING_MISMATCH');
    expect(store.getEnrollment(vscode.enrollmentId)?.currentGeneration).toBe(0);
    expect(store.getEnrollment(cursor.enrollmentId)?.currentGeneration).toBe(0);
    store.close();
  });

  it('permits concurrent read-only review operations while preserving exact product attribution and cancellation isolation', () => {
    const root = tempRoot();
    const store = new IdeSessionStore(join(root, 'ide.db'));
    const vscode = store.createEnrollment(enrollment('vscode'));
    const cursor = store.createEnrollment(enrollment('cursor'));
    const vscodeSession = store.openSession({ ...enrollmentKey(vscode), sessionId: `ides_${'5'.repeat(32)}` });
    const cursorSession = store.openSession({ ...enrollmentKey(cursor), sessionId: `ides_${'6'.repeat(32)}` });
    const vscodeKey = sessionKey(vscode, vscodeSession);
    const cursorKey = sessionKey(cursor, cursorSession);
    store.markAvailable(vscodeKey);
    store.markAvailable(cursorKey);
    const vscodeLease = store.acquireController(vscodeKey);
    const cursorLease = store.acquireController(cursorKey);

    const vscodeOp = store.startOperation({
      enrollmentId: vscode.enrollmentId,
      ideInstanceId: vscode.ideInstanceId,
      sessionId: vscodeSession.sessionId,
      connectionGeneration: vscodeSession.connectionGeneration,
      controllerLeaseId: vscodeLease,
      operationId: `ideo_${'a'.repeat(32)}`,
      capability: 'request_review',
      runtimeInstanceId: `iderun_${'a'.repeat(32)}`,
      adapterId: 'quarangate-vscode-companion',
      adapterVersion: '0.1.0',
      payloadSha256: 'a'.repeat(64),
      payloadBytes: 17,
    });
    const cursorOp = store.startOperation({
      enrollmentId: cursor.enrollmentId,
      ideInstanceId: cursor.ideInstanceId,
      sessionId: cursorSession.sessionId,
      connectionGeneration: cursorSession.connectionGeneration,
      controllerLeaseId: cursorLease,
      operationId: `ideo_${'b'.repeat(32)}`,
      capability: 'request_review',
      runtimeInstanceId: `iderun_${'b'.repeat(32)}`,
      adapterId: 'quarangate-cursor-companion',
      adapterVersion: '0.1.0',
      payloadSha256: 'b'.repeat(64),
      payloadBytes: 19,
    });

    expect(vscodeOp).toMatchObject({ ideProduct: 'vscode', state: 'RUNNING', writerLeaseId: null });
    expect(cursorOp).toMatchObject({ ideProduct: 'cursor', state: 'RUNNING', writerLeaseId: null });
    expect(store.getOperationAudit(vscodeOp.operationId)[0]).toMatchObject({ sequence: 0, eventType: 'operation_started' });
    expect(store.getOperationAudit(cursorOp.operationId)[0]).toMatchObject({ sequence: 0, eventType: 'operation_started' });

    store.requestOperationCancellation({
      enrollmentId: vscode.enrollmentId,
      ideInstanceId: vscode.ideInstanceId,
      sessionId: vscodeSession.sessionId,
      connectionGeneration: vscodeSession.connectionGeneration,
      controllerLeaseId: vscodeLease,
      operationId: vscodeOp.operationId,
      capability: 'cancel',
    });
    expect(store.getOperation(vscodeOp.operationId)?.state).toBe('CANCELLING');
    expect(store.getOperation(cursorOp.operationId)?.state).toBe('RUNNING');
    store.close();
  });

  it('restart recovery stales live sessions for both products without cross-product resurrection', () => {
    const root = tempRoot();
    const db = join(root, 'ide.db');
    const store = new IdeSessionStore(db);
    const vscode = store.createEnrollment(enrollment('vscode'));
    const cursor = store.createEnrollment(enrollment('cursor'));
    const vscodeSession = store.openSession({ ...enrollmentKey(vscode), sessionId: `ides_${'7'.repeat(32)}` });
    const cursorSession = store.openSession({ ...enrollmentKey(cursor), sessionId: `ides_${'8'.repeat(32)}` });
    store.markAvailable(sessionKey(vscode, vscodeSession));
    store.markAvailable(sessionKey(cursor, cursorSession));
    const recovered = store.recoverAfterRestart();
    expect(new Set(recovered.staledSessionIds)).toEqual(new Set([vscodeSession.sessionId, cursorSession.sessionId]));
    expect(recovered.indeterminateOperationIds).toEqual([]);
    expect(store.getSession(vscodeSession.sessionId)?.state).toBe('STALE');
    expect(store.getSession(cursorSession.sessionId)?.state).toBe('STALE');
    expect(store.getEnrollment(vscode.enrollmentId)?.currentGeneration).toBe(1);
    expect(store.getEnrollment(cursor.enrollmentId)?.currentGeneration).toBe(1);
    store.close();
  });

  it('uses one product-neutral live-writer arbiter so VS Code and Cursor cannot both own one worktree', () => {
    const root = tempRoot();
    const writers = new AgentJobStore(join(root, 'agents.db'));
    const vscodeOwner = {
      projectId,
      worktreeId,
      ownerKind: 'ide' as const,
      ownerId: `ideo_${'c'.repeat(32)}`,
      principalId,
    };
    const cursorOwner = {
      projectId,
      worktreeId,
      ownerKind: 'ide' as const,
      ownerId: `ideo_${'d'.repeat(32)}`,
      principalId,
    };
    const first = writers.acquireLiveWriterLease(vscodeOwner);
    expect(first.state).toBe('ACTIVE');
    expect(errorCode(() => writers.acquireLiveWriterLease(cursorOwner))).toBe('LIVE_WRITER_BUSY');
    const cursorOther = writers.acquireLiveWriterLease({ ...cursorOwner, worktreeId: 'cursor-review' });
    expect(cursorOther.state).toBe('ACTIVE');
    writers.close();
  });

  it('restart never frees potentially mutating IDE writers from either adapter', () => {
    const root = tempRoot();
    const writers = new AgentJobStore(join(root, 'agents.db'));
    const vscode = writers.acquireLiveWriterLease({
      projectId: 'vscode-project', worktreeId: 'main', ownerKind: 'ide', ownerId: `ideo_${'e'.repeat(32)}`, principalId,
    });
    const cursor = writers.acquireLiveWriterLease({
      projectId: 'cursor-project', worktreeId: 'main', ownerKind: 'ide', ownerId: `ideo_${'f'.repeat(32)}`, principalId,
    });
    const recovered = writers.recoverApplyAttempts('I6 restart');
    expect(recovered.uncertainWriterLeaseIds).toEqual(expect.arrayContaining([vscode.writerLeaseId, cursor.writerLeaseId]));
    expect(writers.getLiveWriterLease(vscode.writerLeaseId)?.state).toBe('UNCERTAIN');
    expect(writers.getLiveWriterLease(cursor.writerLeaseId)?.state).toBe('UNCERTAIN');
    expect(errorCode(() => writers.acquireLiveWriterLease({
      projectId: 'vscode-project', worktreeId: 'main', ownerKind: 'ide', ownerId: `ideo_${'1'.repeat(32)}`, principalId,
    }))).toBe('LIVE_WRITER_BUSY');
    expect(errorCode(() => writers.acquireLiveWriterLease({
      projectId: 'cursor-project', worktreeId: 'main', ownerKind: 'ide', ownerId: `ideo_${'2'.repeat(32)}`, principalId,
    }))).toBe('LIVE_WRITER_BUSY');
    writers.close();
  });

  it('keeps both production extension entrypoints free of arbitrary host-command, workspace-write, private Cursor and MCP authority', () => {
    const vscodeSource = readFileSync(join(process.cwd(), 'extensions/quarangate-vscode/src/extension.ts'), 'utf8');
    const cursorSource = readFileSync(join(process.cwd(), 'extensions/quarangate-cursor/src/extension.ts'), 'utf8');
    for (const source of [vscodeSource, cursorSource]) {
      expect(source).not.toMatch(/child_process|node:child_process|createTerminal\s*\(|executeCommand\s*\(|workspace\.fs\.(?:write|delete|rename|copy)/u);
      expect(source).not.toMatch(/clipboard|keyboard|mouse|composer|agent\.invoke/iu);
      expect(source).not.toMatch(/cursor\.mcp|registerMcpServer|registerPluginPath/iu);
      expect(source).not.toMatch(/docker\.sock|\/var\/run\/docker/iu);
    }
  });

  it('fails the whole multi-adapter startup if one listener cannot bind instead of leaving a partial live surface', async () => {
    const l = productionLayout();
    writeDualConfig(l.configPath);
    const events: string[] = [];
    await expect(startIdeCompanionProduction({
      configPath: l.configPath,
      databasePath: l.databasePath,
      runtimeRoot: l.runtimeRoot,
      listenerFactory: (opts) => {
        const product = opts.runtime.ideProduct;
        return {
          start: async () => {
            events.push(`start:${product}`);
            if (product === 'cursor') throw new Error('synthetic Cursor bind failure');
          },
          stop: async () => { events.push(`stop:${product}`); },
        } as never;
      },
    })).rejects.toThrow(/synthetic Cursor bind failure/);
    expect(events).toEqual(['start:vscode', 'start:cursor', 'stop:cursor', 'stop:vscode']);
  });
});
