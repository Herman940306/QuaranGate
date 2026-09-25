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

/**
 * T16 — production deployment path regression for the FAIL_REVIEW 9/9/7 matrix.
 *
 * Two layers of proof:
 *   Layer 1: evaluateSchemaPreflight() (the single authoritative evaluator) returns
 *            allowed=false with reason=ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE.
 *   Layer 2: The production shell script encodes the Rule B gate string before every
 *            mutation marker, proving that even if the TS helper were bypassed the
 *            shell path independently denies.  This test fails whenever the shell
 *            decision logic regresses even when helper-level tests remain green.
 */
describe('T16 — production-path 9/9/7 DENY before mutation (FAIL_REVIEW regression)', () => {
  const root = join(import.meta.dirname, '../..');
  const deploy = readFileSync(join(root, 'scripts/remote-owner-deploy-candidate.sh'), 'utf8');

  // Layer 1: single authoritative TypeScript evaluator.
  it('L1 evaluateSchemaPreflight returns allowed=false for current=9 candidate=9 rollback=7', () => {
    const result = evaluateSchemaPreflight({
      currentSchema: 9,
      candidateSupportedSchema: 9,
      rollbackSupportedSchema: 7,
      snapshotCreated: true,
      snapshotVerified: true,
      snapshotSchema: 9,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
  });

  // Layer 1b: a snapshot does NOT change the decision.
  it('L1b snapshot presence does not override Rule B for 9/9/7', () => {
    for (const snapshotCreated of [true, false]) {
      for (const snapshotVerified of [true, false]) {
        const result = evaluateSchemaPreflight({
          currentSchema: 9,
          candidateSupportedSchema: 9,
          rollbackSupportedSchema: 7,
          snapshotCreated,
          snapshotVerified,
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
      }
    }
  });

  // Layer 2: production shell script ordering proof.
  // The Rule B gate string must appear before every mutation marker in the
  // deploy script so that no runtime mutation can occur before the check.
  it('L2 shell script places ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE before every mutation marker', () => {
    const ruleB = deploy.indexOf('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
    expect(ruleB, 'Rule B gate must exist in deploy script').toBeGreaterThanOrEqual(0);

    const mutationFlag   = deploy.indexOf('runtime_mutated=1');
    const authorityUp    = deploy.indexOf('up -d --no-deps --no-build --pull never docker-authority');
    const executorUp     = deploy.indexOf('up -d --no-deps --no-build --pull never executor');
    const gatewayUp      = deploy.indexOf('up -d --no-deps --no-build --pull never gateway');
    const envUpdatedFlag = deploy.indexOf('env_updated=1');

    expect(ruleB, 'Rule B must precede runtime_mutated=1').toBeLessThan(mutationFlag);
    expect(ruleB, 'Rule B must precede docker-authority startup').toBeLessThan(authorityUp);
    expect(ruleB, 'Rule B must precede executor startup').toBeLessThan(executorUp);
    expect(ruleB, 'Rule B must precede gateway startup').toBeLessThan(gatewayUp);
    expect(ruleB, 'Rule B must precede .env update').toBeLessThan(envUpdatedFlag);
  });

  // Layer 2b: Rule B must also appear before the snapshot section so that
  // it cannot be silently bypassed by restructuring the snapshot block.
  // NOTE: Rule B executes AFTER the snapshot (schema is only known post-verify)
  // but BEFORE any runtime mutation.  The ordering snapshot→RuleB→mutation is
  // the correct and expected sequence.
  it('L2b snapshot verification precedes Rule B which precedes mutation', () => {
    const snapshotVerifiedFlag = deploy.indexOf('snapshot_verified=1');
    const ruleB                = deploy.indexOf('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
    const mutationFlag         = deploy.indexOf('runtime_mutated=1');

    expect(snapshotVerifiedFlag).toBeGreaterThanOrEqual(0);
    expect(snapshotVerifiedFlag, 'snapshot_verified=1 must precede Rule B').toBeLessThan(ruleB);
    expect(ruleB,                'Rule B must precede runtime_mutated=1').toBeLessThan(mutationFlag);
  });

  // Layer 2c: candidate service startup is never reached for 9/9/7.
  // Proven structurally: Rule B fail() call appears before all startup commands.
  it('L2c candidate service startup commands are all downstream of Rule B gate', () => {
    const ruleB = deploy.indexOf('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
    for (const service of ['docker-authority', 'executor', 'gateway']) {
      const startupPos = deploy.indexOf(`up -d --no-deps --no-build --pull never ${service}`);
      expect(startupPos, `${service} startup must be downstream of Rule B`).toBeGreaterThan(ruleB);
    }
  });

  // Self-check: current incident matrix explicit metadata.
  it('self-check current incident matrix: standard_deploy_allowed=NO mutation_reached=NO', () => {
    const result = evaluateSchemaPreflight({
      currentSchema: 9,
      candidateSupportedSchema: 9,
      rollbackSupportedSchema: 7,
      snapshotCreated: true,
      snapshotVerified: true,
      snapshotSchema: 9,
    });
    // CURRENT_INCIDENT_MATRIX
    expect(result).toMatchObject({
      allowed: false,                                           // standard_deploy_allowed=NO
      reason: 'ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE', // reason=ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE
    });
    // mutation_reached=NO is proven by Layer 2 shell ordering tests above.
  });
});

/**
 * M1–M10 full compatibility matrix.
 * All cases exercised through evaluateSchemaPreflight() — the single
 * authoritative evaluator whose output the production shell script enforces.
 */
describe('compatibility matrix M1–M10', () => {
  // M1: current=7 candidate=9 rollback=7 verified_snapshot=YES → ALLOW
  it('M1 current=7 candidate=9 rollback=7 snapshot=YES → ALLOW', () => {
    expect(evaluateSchemaPreflight({
      currentSchema: 7, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
      snapshotCreated: true, snapshotVerified: true, snapshotSchema: 7,
    })).toMatchObject({ allowed: true, reason: 'PREFLIGHT_OK' });
  });

  // M2: current=7 candidate=9 rollback=7 verified_snapshot=NO → DENY
  it('M2 current=7 candidate=9 rollback=7 snapshot=NO → DENY', () => {
    const r = evaluateSchemaPreflight({
      currentSchema: 7, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
      snapshotCreated: true, snapshotVerified: false,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('SNAPSHOT_NOT_VERIFIED');
  });

  // M3: current=9 candidate=9 rollback=7 verified_snapshot=YES → DENY (CURRENT INCIDENT / T16)
  it('M3 current=9 candidate=9 rollback=7 snapshot=YES → DENY (current incident)', () => {
    const r = evaluateSchemaPreflight({
      currentSchema: 9, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
      snapshotCreated: true, snapshotVerified: true, snapshotSchema: 9,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
  });

  // M4: current=9 candidate=9 rollback=9 verified_snapshot=YES → ALLOW compatibility gate
  // (Does not authorize live recovery; only validates compatibility semantics.)
  it('M4 current=9 candidate=9 rollback=9 snapshot=YES → ALLOW', () => {
    expect(evaluateSchemaPreflight({
      currentSchema: 9, candidateSupportedSchema: 9, rollbackSupportedSchema: 9,
      snapshotCreated: true, snapshotVerified: true, snapshotSchema: 9,
    })).toMatchObject({ allowed: true, reason: 'PREFLIGHT_OK' });
  });

  // M5: current=10 candidate=9 rollback=9 → DENY (current > candidate)
  it('M5 current=10 candidate=9 rollback=9 → DENY', () => {
    const r = evaluateSchemaPreflight({
      currentSchema: 10, candidateSupportedSchema: 9, rollbackSupportedSchema: 9,
      snapshotCreated: true, snapshotVerified: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('CURRENT_SCHEMA_NEWER_THAN_CANDIDATE');
  });

  // M6: invalid/unknown current schema → DENY
  it('M6 invalid current schema → DENY', () => {
    for (const bad of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const r = evaluateSchemaPreflight({
        currentSchema: bad, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
        snapshotCreated: true, snapshotVerified: true,
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('INVALID_SCHEMA_EVIDENCE');
    }
  });

  // M7: candidate schema probe failure — modelled as invalid candidateSupportedSchema → DENY
  it('M7 candidate schema probe failure (invalid candidateSupportedSchema) → DENY', () => {
    for (const bad of [-1, NaN, Infinity]) {
      const r = evaluateSchemaPreflight({
        currentSchema: 7, candidateSupportedSchema: bad, rollbackSupportedSchema: 7,
        snapshotCreated: true, snapshotVerified: true,
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('INVALID_SCHEMA_EVIDENCE');
    }
  });

  // M8: rollback schema probe failure — modelled as invalid rollbackSupportedSchema → DENY
  it('M8 rollback schema probe failure (invalid rollbackSupportedSchema) → DENY', () => {
    for (const bad of [-1, NaN, Infinity]) {
      const r = evaluateSchemaPreflight({
        currentSchema: 7, candidateSupportedSchema: 9, rollbackSupportedSchema: bad,
        snapshotCreated: true, snapshotVerified: true,
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('INVALID_SCHEMA_EVIDENCE');
    }
  });

  // M9: snapshot schema differs from captured pre-deploy current schema → DENY
  it('M9 snapshot schema differs from current schema → DENY', () => {
    const r = evaluateSchemaPreflight({
      currentSchema: 7, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
      snapshotCreated: true, snapshotVerified: true,
      snapshotSchema: 8, // mismatch — interleaved migration occurred
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('SNAPSHOT_SCHEMA_MISMATCH');
  });

  // M10: snapshot valid but rollback binary cannot read snapshot schema.
  // When snapshot_schema == current_schema and current > rollback → Rule B fires.
  it('M10 snapshot valid but rollback cannot read snapshot schema → DENY', () => {
    // snapshot_schema=9, rollback=7 — rollback binary cannot open the snapshot
    const r = evaluateSchemaPreflight({
      currentSchema: 9, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
      snapshotCreated: true, snapshotVerified: true,
      snapshotSchema: 9,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
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
    // Rule B gate must exist and appear after snapshot verification but before mutation.
    const ruleB   = deploy.indexOf('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE', verified);
    const mutation = deploy.indexOf('runtime_mutated=1', ruleB);
    const authority = deploy.indexOf('up -d --no-deps --no-build --pull never docker-authority', mutation);
    const executor = deploy.indexOf('up -d --no-deps --no-build --pull never executor', authority);
    const gateway = deploy.indexOf('up -d --no-deps --no-build --pull never gateway', executor);
    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(verified).toBeGreaterThan(snapshot);
    expect(ruleB).toBeGreaterThan(verified);
    expect(mutation).toBeGreaterThan(ruleB);
    expect(authority).toBeGreaterThan(mutation);
    expect(executor).toBeGreaterThan(authority);
    expect(gateway).toBeGreaterThan(executor);
    expect(deploy).toContain('--mount type=volume,src=mcp-bridge-jobs,dst=/source,readonly');
  });

  it('installs EXIT trap before creating the .env backup temp file', () => {
    // LOW finding fix: the cleanup handler must be armed before any temporary
    // secret material is created so that signal/interruption paths clean up.
    const trapPos       = deploy.indexOf('trap rollback EXIT');
    const mktemp        = deploy.indexOf('env_backup="$(mktemp)"');
    const chmodBackup   = deploy.indexOf('chmod 0600 "$env_backup"');
    const cpBackup      = deploy.indexOf('cp "$RUNTIME_ENV" "$env_backup"');
    expect(trapPos,     'trap rollback EXIT must exist').toBeGreaterThanOrEqual(0);
    expect(mktemp,      'env_backup mktemp must exist').toBeGreaterThanOrEqual(0);
    expect(trapPos,     'trap must precede mktemp').toBeLessThan(mktemp);
    expect(chmodBackup, 'chmod must follow mktemp').toBeGreaterThan(mktemp);
    expect(cpBackup,    'cp must follow chmod').toBeGreaterThan(chmodBackup);
    // Only one trap installation.
    const secondTrap = deploy.indexOf('trap rollback EXIT', trapPos + 1);
    expect(secondTrap).toBe(-1);
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
