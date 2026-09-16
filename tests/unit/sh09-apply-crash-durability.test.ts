import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';

const JOB = `job_${'9'.repeat(32)}`;
const ATTEMPT = `att_${'8'.repeat(32)}`;
const PROJECT = 'sh09-chaos-project';
const child = resolve('tests/fixtures/sh09-apply-crash-child.ts');

const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function dbPath(label: string): string { const root = mkdtempSync(join(tmpdir(), `sh09-${label}-`)); tempRoots.push(root); return join(root, 'agents.db'); }
function runChild(db: string, mode: string, expectKill = true): void {
  const r = spawnSync(process.execPath, ['--import', 'tsx', child, db, mode], { encoding: 'utf8', timeout: 30_000 });
  if (expectKill) {
    expect(r.signal, `${mode} stderr=${r.stderr}`).toBe('SIGKILL');
  } else {
    expect(r.status, `${mode} stderr=${r.stderr}`).toBe(0);
  }
}
function states(store: AgentJobStore) {
  const attempt = store.getApplyAttempt(ATTEMPT)!;
  const lease = store.getLiveWriterLease(attempt.writerLeaseId!)!;
  return { attempt, lease, job: store.get(JOB)!, project: store.getProjectApplyState(PROJECT) };
}

describe('SH-09 process-crash durability on real SQLite WAL', () => {
  it.each(['STARTED', 'VERIFYING'] as const)('%s crash reopens as proven no-mutation and releases writer on recovery', (mode) => {
    const db = dbPath(mode.toLowerCase()); runChild(db, mode);
    const store = new AgentJobStore(db);
    let s = states(store);
    expect(s.attempt.state).toBe(mode);
    expect(s.lease.state).toBe('ACTIVE');
    expect(s.project).toBeUndefined();
    const r = store.recoverApplyAttempts(`SH09 restart after ${mode}`);
    expect(r.abortedNoMutation).toEqual([ATTEMPT]);
    s = states(store);
    expect(s.attempt.state).toBe('ABORTED_NO_MUTATION');
    expect(s.lease.state).toBe('RELEASED');
    expect(s.project).toBeUndefined();
    expect(s.job.status).toBe('COMPLETED');
    store.close();
  });

  it('APPLYING crash with a durable journal row becomes UNCERTAIN + quarantine and preserves the journal', () => {
    const db = dbPath('applying-journal'); runChild(db, 'APPLYING_JOURNALED');
    const store = new AgentJobStore(db);
    expect(store.getApplyAttempt(ATTEMPT)!.state).toBe('APPLYING');
    expect(store.listApplyJournalForAttempt(ATTEMPT)).toMatchObject([{ opIndex: 0, path: 'src/landed.txt', op: 'CONTENT_MODIFY' }]);
    const r = store.recoverApplyAttempts('SH09 crash after mutation journal commit');
    expect(r.uncertain).toEqual([ATTEMPT]);
    const s = states(store);
    expect(s.attempt.state).toBe('UNCERTAIN');
    expect(s.lease.state).toBe('UNCERTAIN');
    expect(s.project?.state).toBe('QUARANTINED');
    expect(s.project?.quarantineCausingAttemptId).toBe(ATTEMPT);
    expect(s.job.status).toBe('COMPLETED');
    expect(store.listApplyJournalForAttempt(ATTEMPT)).toHaveLength(1);
    expect(store.recoverApplyAttempts('SH09 second restart')).toEqual({ abortedNoMutation: [], uncertain: [], uncertainWriterLeaseIds: [] });
    expect(() => store.startApplyAttempt({ attemptId: `att_${'7'.repeat(32)}`, jobId: JOB, worktreeId: 'main' })).toThrow(/quarantined/i);
    store.close();
  });

  it('a success committed before process death remains APPLIED and is never reclassified by restart recovery', () => {
    const db = dbPath('success'); runChild(db, 'SUCCESS');
    const store = new AgentJobStore(db);
    const s = states(store);
    expect(s.attempt.state).toBe('VERIFIED_SUCCESS');
    expect(s.lease.state).toBe('RELEASED');
    expect(s.job.status).toBe('APPLIED');
    expect(s.job.appliedAt).toBeTruthy();
    expect(s.project).toBeUndefined();
    expect(store.recoverApplyAttempts('SH09 restart after committed success')).toEqual({ abortedNoMutation: [], uncertain: [], uncertainWriterLeaseIds: [] });
    expect(states(store).job.appliedAt).toBe(s.job.appliedAt);
    store.close();
  });

  it('SIGKILL before COMMIT of the success transaction exposes none of its partial cross-table writes', () => {
    const db = dbPath('torn-success'); runChild(db, 'RAW_SUCCESS_TX_KILL');
    const store = new AgentJobStore(db);
    let s = states(store);
    expect(s.attempt.state).toBe('APPLYING');
    expect(s.lease.state).toBe('ACTIVE');
    expect(s.job.status).toBe('COMPLETED');
    expect(s.job.appliedAt).toBeNull();
    expect(s.project).toBeUndefined();
    store.recoverApplyAttempts('SH09 torn success transaction');
    s = states(store);
    expect(s.attempt.state).toBe('UNCERTAIN');
    expect(s.lease.state).toBe('UNCERTAIN');
    expect(s.job.status).toBe('COMPLETED');
    expect(s.project?.state).toBe('QUARANTINED');
    store.close();
  });

  it('SIGKILL before COMMIT of recovery exposes none of its partial quarantine/writer writes; next recovery is atomic', () => {
    const db = dbPath('torn-recovery'); runChild(db, 'RAW_RECOVERY_TX_KILL');
    const store = new AgentJobStore(db);
    let s = states(store);
    expect(s.attempt.state).toBe('APPLYING');
    expect(s.lease.state).toBe('ACTIVE');
    expect(s.project).toBeUndefined();
    const r = store.recoverApplyAttempts('SH09 retry recovery');
    expect(r.uncertain).toEqual([ATTEMPT]);
    s = states(store);
    expect(s.attempt.state).toBe('UNCERTAIN');
    expect(s.lease.state).toBe('UNCERTAIN');
    expect(s.project?.state).toBe('QUARANTINED');
    store.close();
  });

  it('an injected failure inside recovery rolls the whole transaction back and a later retry can complete', () => {
    const db = dbPath('recovery-abort'); runChild(db, 'PREPARE_APPLYING_EXIT', false);
    const raw = new DatabaseSync(db);
    raw.exec(`CREATE TRIGGER sh09_fail_quarantine BEFORE INSERT ON agent_project_apply_state
      WHEN NEW.state='QUARANTINED' BEGIN SELECT RAISE(ABORT, 'sh09 injected recovery fault'); END;`);
    raw.close();

    const store = new AgentJobStore(db);
    expect(() => store.recoverApplyAttempts('SH09 injected transaction failure')).toThrow(/sh09 injected recovery fault/);
    let s = states(store);
    expect(s.attempt.state).toBe('APPLYING');
    expect(s.lease.state).toBe('ACTIVE');
    expect(s.project).toBeUndefined();
    store.close();

    const cleanup = new DatabaseSync(db); cleanup.exec('DROP TRIGGER sh09_fail_quarantine'); cleanup.close();
    const retry = new AgentJobStore(db);
    expect(retry.recoverApplyAttempts('SH09 retry after fault').uncertain).toEqual([ATTEMPT]);
    s = states(retry);
    expect(s.attempt.state).toBe('UNCERTAIN');
    expect(s.lease.state).toBe('UNCERTAIN');
    expect(s.project?.state).toBe('QUARANTINED');
    retry.close();
  });
});
