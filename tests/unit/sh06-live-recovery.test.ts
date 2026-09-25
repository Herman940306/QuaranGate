import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSnapshot,
  inspectDatabase,
  restoreSnapshot,
  verifySnapshot,
} from '../../src/operations/sh06JobDbRecovery.js';
import {
  classifyGithubBaseline,
  evaluateReadinessSequence,
  evaluateSchemaPreflight,
  githubRollbackAction,
  rollbackPassed,
  type ReadinessObservation,
} from '../../src/operations/sh06Recovery.js';
import { redactDiagnostic } from '../../scripts/sh06-redact-diagnostic.mjs';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'qg-sh06-recovery-'));
  chmodSync(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}

function createDatabase(path: string, version: number, value: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE rollback_proof(value TEXT NOT NULL);');
  db.prepare('INSERT INTO rollback_proof(value) VALUES (?)').run(value);
  db.exec(`PRAGMA user_version=${version}`);
  chmodSync(path, 0o600);
  return db;
}

function observation(service: string, healthState: ReadinessObservation['healthState']): ReadinessObservation {
  return { service, runtimeState: 'running', healthState };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('SH-06 persistent-state recovery', () => {
  it('T1 snapshots live WAL state at v7 and restores exact predeploy bytes after a simulated v9 migration', async () => {
    const dir = temporaryDirectory();
    const database = join(dir, 'agents.db');
    const snapshot = join(dir, 'rollback.db');
    const manifest = join(dir, 'rollback.json');
    const writer = createDatabase(database, 7, 'predeploy');

    const created = await createSnapshot(database, snapshot, manifest);
    expect(created.proof.userVersion).toBe(7);
    expect(created.proof.integrityCheck).toBe('ok');
    writer.prepare('UPDATE rollback_proof SET value = ?').run('candidate');
    writer.exec('PRAGMA user_version=9');
    writer.close();
    expect(inspectDatabase(database).userVersion).toBe(9);

    const restored = restoreSnapshot(snapshot, manifest, database);
    expect(restored.userVersion).toBe(7);
    expect(restored.sha256).toBe(created.proof.sha256);
    const verification = new DatabaseSync(database, { readOnly: true });
    expect(verification.prepare('SELECT value FROM rollback_proof').get()).toEqual({ value: 'predeploy' });
    verification.close();
  });

  it('T2 denies mutation when snapshot creation did not succeed', () => {
    expect(evaluateSchemaPreflight({
      currentSchema: 7, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
      snapshotCreated: false, snapshotVerified: false,
    })).toMatchObject({ allowed: false, reason: 'SNAPSHOT_NOT_CREATED' });
  });

  it('T3 rejects a snapshot whose integrity proof no longer matches', async () => {
    const dir = temporaryDirectory();
    const database = join(dir, 'agents.db');
    const snapshot = join(dir, 'rollback.db');
    const manifest = join(dir, 'rollback.json');
    createDatabase(database, 7, 'predeploy').close();
    await createSnapshot(database, snapshot, manifest);
    const bytes = readFileSync(snapshot);
    bytes[Math.max(100, bytes.length - 100)] ^= 0xff;
    writeFileSync(snapshot, bytes);
    expect(() => verifySnapshot(snapshot, manifest)).toThrow();
  });

  it('T4 reports rollback failure when persistent restoration fails despite image restoration', () => {
    expect(rollbackPassed({
      imageState: true, persistentState: false, configState: true,
      githubState: true, networkState: true, healthState: true,
    })).toBe(false);
  });
});

describe('SH-06 GitHub baseline and rollback', () => {
  it('T5 classifies direct label-discovered broker and proxy cardinality as present', () => {
    expect(classifyGithubBaseline({ brokerIds: ['broker-id'], proxyIds: ['proxy-id'] })).toBe('PRESENT');
    expect(() => classifyGithubBaseline({ brokerIds: ['one', 'two'], proxyIds: ['proxy'] })).toThrow('AMBIGUOUS');
  });

  it('T6 preserves/restores preexisting GitHub services after candidate failure', () => {
    expect(githubRollbackAction('PRESENT', true)).toBe('RESTORE_PREEXISTING');
  });

  it('T7 removes only candidate-created GitHub services when the baseline was absent', () => {
    expect(githubRollbackAction('ABSENT', true)).toBe('REMOVE_CANDIDATE_CREATED');
    expect(githubRollbackAction('ABSENT', false)).toBe('NO_ACTION');
  });
});

describe('SH-06 ordered readiness', () => {
  const phases = ['docker-authority', 'executor', 'gateway'] as const;

  it('T8 stops at docker-authority and never admits executor or gateway', () => {
    const result = evaluateReadinessSequence(phases, new Map([
      ['docker-authority', observation('docker-authority', 'unhealthy')],
      ['executor', observation('executor', 'healthy')],
      ['gateway', observation('gateway', 'healthy')],
    ]));
    expect(result).toEqual({ ready: false, admitted: [], failedService: 'docker-authority', classification: 'UNHEALTHY' });
  });

  it('T9 classifies an executor failure without blaming or admitting gateway', () => {
    const result = evaluateReadinessSequence(phases, new Map([
      ['docker-authority', observation('docker-authority', 'healthy')],
      ['executor', { service: 'executor', runtimeState: 'exited', healthState: 'unhealthy' }],
      ['gateway', observation('gateway', 'healthy')],
    ]));
    expect(result).toEqual({ ready: false, admitted: ['docker-authority'], failedService: 'executor', classification: 'EXITED' });
  });

  it('T10 classifies gateway only after authority and executor are ready', () => {
    const result = evaluateReadinessSequence(phases, new Map([
      ['docker-authority', observation('docker-authority', 'healthy')],
      ['executor', observation('executor', 'healthy')],
      ['gateway', observation('gateway', 'unhealthy')],
    ]));
    expect(result).toEqual({ ready: false, admitted: ['docker-authority', 'executor'], failedService: 'gateway', classification: 'UNHEALTHY' });
  });
});

describe('SH-06 schema gate', () => {
  it('T11 aborts when current schema is newer than candidate support', () => {
    expect(evaluateSchemaPreflight({
      currentSchema: 10, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
      snapshotCreated: true, snapshotVerified: true,
    })).toMatchObject({ allowed: false, reason: 'CURRENT_SCHEMA_NEWER_THAN_CANDIDATE' });
  });

  it('T12 aborts when candidate exceeds rollback support without a verified snapshot', () => {
    expect(evaluateSchemaPreflight({
      currentSchema: 7, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
      snapshotCreated: true, snapshotVerified: false,
    })).toMatchObject({ allowed: false, snapshotMandatory: true, reason: 'SNAPSHOT_NOT_VERIFIED' });
  });
});

describe('SH-06 deployment source contract', () => {
  const root = join(import.meta.dirname, '../..');
  const deploy = readFileSync(join(root, 'scripts/remote-owner-deploy-candidate.sh'), 'utf8');
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8');
  const redactor = readFileSync(join(root, 'scripts/sh06-redact-diagnostic.mjs'), 'utf8');

  it('orders snapshot verification and schema preflight before every candidate startup', () => {
    const snapshot = deploy.indexOf('snapshot /source/agents.db /snapshot/agents.db /snapshot/manifest.json');
    const verified = deploy.indexOf('snapshot_verified=1', snapshot);
    const mutation = deploy.indexOf('runtime_mutated=1', verified);
    const authority = deploy.indexOf('up -d --no-deps --no-build --pull never docker-authority', mutation);
    const executor = deploy.indexOf('up -d --no-deps --no-build --pull never executor', authority);
    const gateway = deploy.indexOf('up -d --no-deps --no-build --pull never gateway', executor);
    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(verified).toBeGreaterThan(snapshot);
    expect(mutation).toBeGreaterThan(verified);
    expect(authority).toBeGreaterThan(mutation);
    expect(executor).toBeGreaterThan(authority);
    expect(gateway).toBeGreaterThan(executor);
    expect(deploy).toContain('--mount type=volume,src=mcp-bridge-jobs,dst=/source,readonly');
  });

  it('restores persistent state before any legacy service reinstatement and reports separate dimensions', () => {
    const rollback = deploy.indexOf('rollback()');
    const stop = deploy.indexOf('"${QG[@]}" stop', rollback);
    const restore = deploy.indexOf('restore /snapshot/agents.db /snapshot/manifest.json /jobs/agents.db', stop);
    const persistentProof = deploy.indexOf('ROLLBACK_PERSISTENT_STATE=YES', restore);
    const legacyUp = deploy.indexOf('"${BASE_QG[@]}" up -d', persistentProof);
    expect(stop).toBeGreaterThan(rollback);
    expect(restore).toBeGreaterThan(stop);
    expect(deploy.slice(stop, restore)).toContain('candidate_quiesced');
    expect(deploy).toContain('candidate_services_not_proven_stopped');
    expect(persistentProof).toBeGreaterThan(restore);
    expect(legacyUp).toBeGreaterThan(persistentProof);
    for (const dimension of ['IMAGE', 'PERSISTENT', 'CONFIG', 'GITHUB', 'NETWORK', 'HEALTH']) {
      expect(deploy).toContain(`ROLLBACK_${dimension}_STATE`);
    }
    expect(deploy).toContain('RUNTIME_IMAGE_STATE_RESTORED=YES');
    expect(deploy).toContain('PERSISTENT_STATE_RESTORED=YES');
  });

  it('discovers the GitHub baseline only through exact immutable Docker labels', () => {
    expect(deploy).toContain('label=com.docker.compose.project=quarangate');
    expect(deploy).toContain('label=com.docker.compose.service=github-broker');
    expect(deploy).toContain('label=com.docker.compose.service=github-egress-proxy');
    const baseline = deploy.slice(deploy.indexOf('# GitHub baseline discovery'), deploy.indexOf('# Resolve the exact persisted'));
    expect(baseline).not.toMatch(/\$\{QG\[@\]\}.*ps -q/u);
  });

  it('T13 preserves raw Docker authority boundaries', () => {
    expect(compose.match(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/gu)).toHaveLength(1);
    const executorBlock = compose.slice(compose.indexOf('  executor:'), compose.indexOf('\nnetworks:'));
    expect(executorBlock).not.toContain('/var/run/docker.sock');
    expect(deploy).not.toContain('privileged');
  });

  it('T14 bounds and redacts diagnostics without persisting raw Docker logs', () => {
    const secret = 'top-secret-token-value-12345678901234567890';
    const raw = `authorization: Bearer ${secret} {"token":"short-secret"} job contents`;
    const redacted = redactDiagnostic(raw);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain('short-secret');
    expect(redacted).not.toContain('job contents');
    expect(redacted).toContain('content redacted');
    expect(redacted.length).toBeLessThanOrEqual(240);
    expect(deploy).toContain('sh06-redact-diagnostic.mjs');
    expect(deploy).not.toMatch(/docker\s+logs/u);
    expect(deploy).not.toMatch(/printf[^\n]*DOCKER_AUTHORITY_TOKEN_VALUE/u);
    expect(deploy).not.toMatch(/printf[^\n]*INTERNAL_TOKEN_VALUE/u);
  });

  it('T15 retains exact release-image receipt reuse and never adds registry pulls', () => {
    expect(deploy).toContain('existing release refs require absolute QUARANGATE_DEPLOY_RELEASE_RECEIPT');
    expect(deploy).toContain("source.get('commit') != rev");
    expect(deploy).toContain('existing release ref digest mismatch');
    expect(deploy).toContain('existing release refs changed after receipt validation');
    expect(deploy).not.toMatch(/docker\s+pull/u);
  });
});
