import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { IdeCompanionListener } from '../../src/executor/ide/ideCompanionListener.js';
import { startIdeCompanionProduction } from '../../src/executor/ide/ideCompanionProduction.js';
import { createIdeCompanionRuntime, revokeIdeCompanionSecret } from '../../src/executor/ide/ideCompanionRuntime.js';
import { IdeSessionStore } from '../../src/executor/ide/ideSessionStore.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const roots: string[] = [];

function tempLayout() {
  const base = mkdtempSync(join(tmpdir(), 'qg-i2-prod-'));
  roots.push(base);
  chmodSync(base, 0o700);
  const runtimeRoot = join(base, 'rt'); mkdirSync(runtimeRoot, { mode: 0o700 }); chmodSync(runtimeRoot, 0o700);
  const jobs = join(base, 'jobs'); mkdirSync(jobs, { mode: 0o700 }); chmodSync(jobs, 0o700);
  return { base, runtimeRoot, databasePath: join(jobs, 'ide.db'), configPath: join(base, 'ide-sessions.yaml') };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    principalId: 'chatgpt-browser', projectId: 'quarangate', worktreeId: 'forward', ideProduct: 'vscode',
    ideInstanceId: `ide_${'1'.repeat(32)}`, workspaceFingerprint: 'a'.repeat(64), baseRevision: 'b'.repeat(40),
    capabilities: ['prompt', 'cancel', 'observe_response', 'request_review'], adapterVersion: '0.1.0',
    runtimeInstanceId: `iderun_${'2'.repeat(32)}`,
    ...overrides,
  };
}

function writeConfig(path: string, enrollment = entry()): void {
  writeFileSync(path, YAML.stringify({ version: 1, enrollments: [enrollment] }), { mode: 0o600 });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('P7 I2 IDE companion production composition', () => {
  it('keeps Plane-B unavailable when the dedicated trusted config is absent', async () => {
    const l = tempLayout();
    const runtime = await startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: '' });
    expect(runtime.state).toBe('NOT_CONFIGURED');
    expect(runtime.bootstrapBindings).toEqual([]);
    expect(existsSync(l.databasePath)).toBe(false);
    await runtime.stop();
  });

  it('provisions exact enrollment/runtime and starts review-only remote mode before availability', async () => {
    const l = tempLayout(); writeConfig(l.configPath);
    let captured: ConstructorParameters<typeof IdeCompanionListener>[0] | undefined;
    const runtime = await startIdeCompanionProduction({
      configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot,
      listenerFactory: (opts) => { captured = opts; return new IdeCompanionListener(opts); },
    });
    expect(runtime.state).toBe('AVAILABLE_NOT_LIVE_QUALIFIED');
    expect(captured?.userReviewIntents).toBe(true);
    expect(captured?.operationAdapter).toBeUndefined();
    expect(captured?.writerStore).toBeUndefined();
    expect(captured?.implementationAdapter).toBeUndefined();
    const bootstrap = runtime.bootstrapBindings[0]!;
    expect(bootstrap.credentialPath).toBe(join(l.runtimeRoot, entry().runtimeInstanceId as string, 'credential.json'));
    expect(existsSync(join(l.runtimeRoot, entry().runtimeInstanceId as string, 'companion.sock'))).toBe(true);
    expect(existsSync(l.databasePath)).toBe(true);
    expect(readFileSync(bootstrap.credentialPath, 'utf8')).not.toContain('request_implementation');
    await runtime.stop();
    expect(existsSync(join(l.runtimeRoot, entry().runtimeInstanceId as string, 'companion.sock'))).toBe(false);
    expect(existsSync(bootstrap.credentialPath)).toBe(true);
  });

  it('recovers the same durable runtime/enrollment on ordinary restart without re-enrollment', async () => {
    const l = tempLayout(); writeConfig(l.configPath);
    const first = await startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot });
    const credentialPath = first.bootstrapBindings[0]!.credentialPath;
    const credentialBefore = readFileSync(credentialPath, 'utf8');
    await first.stop();
    const storeBefore = new IdeSessionStore(l.databasePath);
    const enrollmentId = JSON.parse(credentialBefore).enrollmentId as string;
    expect(storeBefore.getEnrollment(enrollmentId)?.currentGeneration).toBe(0);
    storeBefore.close();

    const second = await startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot });
    expect(second.bootstrapBindings[0]!.credentialPath).toBe(credentialPath);
    expect(readFileSync(credentialPath, 'utf8')).toBe(credentialBefore);
    await second.stop();
  });

  it('recovers production startup after an abrupt process death leaves the exact owner-only Unix socket orphaned', async () => {
    const l = tempLayout(); writeConfig(l.configPath);
    const first = await startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot });
    const credentialPath = first.bootstrapBindings[0]!.credentialPath;
    const credentialBefore = readFileSync(credentialPath, 'utf8');
    const socketPath = join(l.runtimeRoot, entry().runtimeInstanceId as string, 'companion.sock');
    await first.stop();

    const child = spawn(process.execPath, ['--input-type=commonjs', '-e', `
      const { chmodSync } = require('node:fs');
      const { createServer } = require('node:net');
      const path = process.argv[1];
      const server = createServer();
      server.on('error', (error) => { console.error(error.code || error.message); process.exit(2); });
      server.listen(path, () => chmodSync(path, 0o600));
      setInterval(() => undefined, 1000);
    `, socketPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let childStderr = '';
    child.stderr!.on('data', (chunk) => { childStderr += chunk.toString('utf8'); });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        if (existsSync(socketPath)) {
          const info = lstatSync(socketPath);
          if (info.isSocket() && (info.mode & 0o777) === 0o600) { ready = true; break; }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      if (!ready) throw new Error(`orphan socket helper did not become ready: ${childStderr.trim() || 'no child diagnostic'}`);
      const orphan = lstatSync(socketPath);
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(existsSync(socketPath)).toBe(true);

      const second = await startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot });
      const rebound = lstatSync(socketPath);
      expect(rebound.isSocket()).toBe(true);
      expect(rebound.mode & 0o777).toBe(0o600);
      expect(rebound.ino).not.toBe(orphan.ino);
      expect(readFileSync(credentialPath, 'utf8')).toBe(credentialBefore);
      await second.stop();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('stales a previously live session before a restarted listener becomes available', async () => {
    const l = tempLayout(); writeConfig(l.configPath);
    const seedStore = new IdeSessionStore(l.databasePath);
    const enrollment = seedStore.createEnrollment({
      principalId: 'chatgpt-browser', projectId: 'quarangate', worktreeId: 'forward', ideProduct: 'vscode',
      ideInstanceId: `ide_${'1'.repeat(32)}`, workspaceFingerprint: 'a'.repeat(64), baseRevision: 'b'.repeat(40),
      capabilities: ['prompt', 'cancel', 'observe_response', 'request_review'],
    });
    createIdeCompanionRuntime({
      runtimeRoot: l.runtimeRoot, enrollmentId: enrollment.enrollmentId, ideInstanceId: enrollment.ideInstanceId,
      ideProduct: 'vscode', adapterVersion: '0.1.0', runtimeInstanceId: entry().runtimeInstanceId as string,
    });
    const session = seedStore.openSession({ ...enrollment, sessionId: `ides_${'3'.repeat(32)}` });
    seedStore.markAvailable({ ...enrollment, sessionId: session.sessionId, connectionGeneration: session.connectionGeneration });
    seedStore.close();

    const runtime = await startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot });
    const verify = new IdeSessionStore(l.databasePath);
    expect(verify.getSession(session.sessionId)?.state).toBe('STALE');
    verify.close();
    await runtime.stop();
  });

  it('fails closed on enrollment drift, unknown runtime entries, revoked credentials and stale sockets', async () => {
    const l = tempLayout(); writeConfig(l.configPath);
    const first = await startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot });
    const credential = first.bootstrapBindings[0]!;
    await first.stop();

    writeConfig(l.configPath, entry({ workspaceFingerprint: 'c'.repeat(64) }));
    await expect(startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot })).rejects.toThrow(/drift/i);
    writeConfig(l.configPath);

    const unknown = join(l.runtimeRoot, `iderun_${'9'.repeat(32)}`); mkdirSync(unknown, { mode: 0o700 }); chmodSync(unknown, 0o700);
    await expect(startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot })).rejects.toThrow(/unconfigured runtime entry/);
    rmSync(unknown, { recursive: true, force: true });

    const raw = JSON.parse(readFileSync(credential.credentialPath, 'utf8')) as { enrollmentId: string };
    const ref = {
      runtimeRoot: l.runtimeRoot, runtimeInstanceId: entry().runtimeInstanceId as string,
      directory: join(l.runtimeRoot, entry().runtimeInstanceId as string), credentialPath: credential.credentialPath,
      socketPath: join(l.runtimeRoot, entry().runtimeInstanceId as string, 'companion.sock'), enrollmentId: raw.enrollmentId,
      ideInstanceId: `ide_${'1'.repeat(32)}`, ideProduct: 'vscode' as const,
      adapterId: 'quarangate-vscode-companion' as const, adapterVersion: '0.1.0',
    };
    revokeIdeCompanionSecret(ref);
    await expect(startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot })).rejects.toThrow(/revoked/i);
  });

  it('fails closed on adapter-version drift and corrupt store/schema bytes', async () => {
    const l = tempLayout(); writeConfig(l.configPath);
    const first = await startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot });
    await first.stop();
    writeConfig(l.configPath, entry({ adapterVersion: '0.2.0' }));
    await expect(startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot })).rejects.toThrow(/credential|adapter/i);

    const corrupt = tempLayout(); writeConfig(corrupt.configPath);
    writeFileSync(corrupt.databasePath, 'not-sqlite', { mode: 0o600 });
    await expect(startIdeCompanionProduction({ configPath: corrupt.configPath, databasePath: corrupt.databasePath, runtimeRoot: corrupt.runtimeRoot })).rejects.toThrow();
  });

  it('stops listeners before closing their durable session store and is idempotent', async () => {
    const l = tempLayout(); writeConfig(l.configPath);
    const events: string[] = [];
    let capturedStore: IdeSessionStore | undefined;
    const runtime = await startIdeCompanionProduction({
      configPath: l.configPath,
      databasePath: l.databasePath,
      runtimeRoot: l.runtimeRoot,
      storeFactory: (path) => { capturedStore = new IdeSessionStore(path); return capturedStore; },
      listenerFactory: () => ({
        start: async () => { events.push('listener.start'); },
        stop: async () => {
          expect(capturedStore?.schemaVersion).toBeGreaterThan(0);
          events.push('listener.stop');
        },
      }) as unknown as IdeCompanionListener,
    });
    await runtime.stop();
    await runtime.stop();
    expect(events).toEqual(['listener.start', 'listener.stop']);
    expect(() => capturedStore?.schemaVersion).toThrow();
  });

  it('fails closed on unsafe runtime roots, database files and unexpected socket paths', async () => {
    const l = tempLayout(); writeConfig(l.configPath);
    chmodSync(l.runtimeRoot, 0o755);
    await expect(startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot })).rejects.toThrow(/permissions|runtime/i);
    chmodSync(l.runtimeRoot, 0o700);

    const first = await startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot });
    const socketPath = join(l.runtimeRoot, entry().runtimeInstanceId as string, 'companion.sock');
    await first.stop();
    writeFileSync(socketPath, 'stale', { mode: 0o600 });
    await expect(startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot })).rejects.toThrow(/socket path already exists/i);
    rmSync(socketPath);
    chmodSync(l.databasePath, 0o644);
    await expect(startIdeCompanionProduction({ configPath: l.configPath, databasePath: l.databasePath, runtimeRoot: l.runtimeRoot })).rejects.toThrow(/database ownership\/type\/mode is unsafe/i);
  });

  it('proves the optional Compose overlay preserves one exact host/container runtime pathname without Docker auto-create or authority widening', () => {
    const overlay = YAML.parse(readFileSync(join(repoRoot, 'compose.ide.yaml'), 'utf8')) as any;
    const executor = overlay.services.executor;
    const runtimeMount = executor.volumes[0];
    expect(runtimeMount.type).toBe('bind');
    expect(runtimeMount.source).toBe(runtimeMount.target);
    expect(runtimeMount.source).toContain('QUARANGATE_IDE_RUNTIME_ROOT:?');
    expect(runtimeMount.bind.create_host_path).toBe(false);
    expect(runtimeMount.read_only).toBe(false);
    expect(executor.environment.IDE_RUNTIME_ROOT).toBe(runtimeMount.target);
    const text = readFileSync(join(repoRoot, 'compose.ide.yaml'), 'utf8');
    expect(text).not.toMatch(/docker\.sock|ports:|0\.0\.0\.0|network_mode|privileged|cap_add/);
  });

  it('adds no model, consent, public API, implementation or writer authority in production startup composition', () => {
    const text = readFileSync(join(repoRoot, 'src/executor/ide/ideCompanionProduction.ts'), 'utf8');
    expect(text).not.toMatch(/sendRequest|request_implementation|writerStore\s*:|implementationAdapter\s*:|executeCommand|createTerminal|workspace\.fs|docker\.sock/i);
  });
});
