import { DatabaseSync } from 'node:sqlite';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { AGENT_RETENTION_DURATION_MS } from '../../src/shared/agents.js';

const dbPath = process.argv[2];
const mode = process.argv[3];
if (!dbPath || !mode) throw new Error('usage: sh09-apply-crash-child.ts <db> <mode>');

const JOB = `job_${'9'.repeat(32)}`;
const ATTEMPT = `att_${'8'.repeat(32)}`;
const PROJECT = 'sh09-chaos-project';

function prepareApplying(target: 'STARTED' | 'VERIFYING' | 'APPLYING' | 'APPLYING_JOURNALED' | 'SUCCESS'): { store: AgentJobStore; leaseId: string } {
  const store = new AgentJobStore(dbPath);
  store.insert({
    jobId: JOB, principalId: 'sh09-owner', backend: 'kiro', project: PROJECT,
    profile: 'implement', resourcePolicy: 'economy', promptHash: 'f'.repeat(64),
    prompt: 'sh09 crash fixture', sessionPolicy: 'new', writer: true,
    retentionClass: 'ephemeral', retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral,
  });
  store.transition(JOB, 'QUEUED', 'PREPARING');
  store.transition(JOB, 'PREPARING', 'RUNNING');
  store.transition(JOB, 'RUNNING', 'VALIDATING');
  store.setBaseCommit(JOB, 'b'.repeat(40));
  store.transition(JOB, 'VALIDATING', 'COMPLETED', { completedAt: new Date().toISOString(), summary: 'fixture', exitCode: 0 });
  const attempt = store.startApplyAttempt({ attemptId: ATTEMPT, jobId: JOB, worktreeId: 'main' });
  if (!attempt.writerLeaseId) throw new Error('writer lease missing');
  if (target !== 'STARTED') store.transitionApplyAttempt(ATTEMPT, 'STARTED', 'VERIFYING');
  if (target === 'APPLYING' || target === 'APPLYING_JOURNALED' || target === 'SUCCESS') {
    store.transitionApplyAttempt(ATTEMPT, 'VERIFYING', 'APPLYING');
  }
  if (target === 'APPLYING_JOURNALED') {
    store.insertApplyJournalRow({
      attemptId: ATTEMPT, opIndex: 0, path: 'src/landed.txt', op: 'CONTENT_MODIFY',
      beforeExisted: true, beforeContentHash: 'c'.repeat(64), beforeMode: 0o644, createdDirs: null,
    });
  }
  if (target === 'SUCCESS') {
    const committed = store.markApplySuccess(ATTEMPT, JOB, { successEvidence: '{"verified":true}', mutatedPathCount: 1 });
    if (!committed) throw new Error('success commit failed');
  }
  return { store, leaseId: attempt.writerLeaseId };
}

function hardKill(): never {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL did not terminate process');
}

if (mode === 'STARTED' || mode === 'VERIFYING' || mode === 'APPLYING' || mode === 'APPLYING_JOURNALED' || mode === 'SUCCESS') {
  prepareApplying(mode);
  hardKill();
}

if (mode === 'RAW_SUCCESS_TX_KILL' || mode === 'RAW_RECOVERY_TX_KILL' || mode === 'PREPARE_APPLYING_EXIT') {
  const { store, leaseId } = prepareApplying('APPLYING');
  store.close();
  if (mode === 'PREPARE_APPLYING_EXIT') process.exit(0);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('BEGIN IMMEDIATE');
  if (mode === 'RAW_SUCCESS_TX_KILL') {
    const now = new Date().toISOString();
    db.prepare(`UPDATE agent_apply_attempts SET state='VERIFIED_SUCCESS', finished_at=?, success_evidence='torn', mutated_path_count=1 WHERE attempt_id=? AND state='APPLYING'`).run(now, ATTEMPT);
    db.prepare(`UPDATE agent_jobs SET status='APPLIED', applied_at=?, disposition_at=?, prompt='' WHERE job_id=? AND status='COMPLETED'`).run(now, now, JOB);
    db.prepare(`UPDATE live_writer_leases SET state='RELEASED', finished_at=?, reason='torn success' WHERE writer_lease_id=? AND state='ACTIVE'`).run(now, leaseId);
  } else {
    const now = new Date().toISOString();
    db.prepare(`UPDATE agent_apply_attempts SET state='UNCERTAIN', finished_at=?, reason='torn recovery' WHERE attempt_id=? AND state='APPLYING'`).run(now, ATTEMPT);
    db.prepare(`INSERT INTO agent_project_apply_state(project_id,state,quarantined_at,quarantine_causing_job_id,quarantine_causing_attempt_id,quarantine_reason) VALUES (?, 'QUARANTINED', ?, ?, ?, 'torn recovery')`).run(PROJECT, now, JOB, ATTEMPT);
    db.prepare(`UPDATE live_writer_leases SET state='UNCERTAIN', finished_at=?, reason='torn recovery' WHERE writer_lease_id=? AND state='ACTIVE'`).run(now, leaseId);
  }
  // Deliberately die with the transaction open. SQLite must expose either the
  // old committed state or a fully committed transaction after restart — never
  // a cross-table partial state. Because COMMIT was never issued, old state is expected.
  hardKill();
}

throw new Error(`unknown SH09 crash mode: ${mode}`);
