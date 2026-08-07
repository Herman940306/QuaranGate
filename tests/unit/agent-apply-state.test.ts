/**
 * A6-B1: persistence + apply-state foundation, INCLUDING the final invariant
 * remediation (D1 generic-disposition bypass, D2 caller-controlled project
 * identity, FK defense-in-depth, UNCERTAIN-blocks-discard, and the real
 * matrix/quarantine-conflict/duplicate-attempt-id coverage called out in the
 * A6-B1 remediation phase).
 *
 * These tests exercise ONLY the durable persistence primitives added in this
 * batch (v3 schema: agent_project_apply_state, agent_apply_attempts, and the
 * new AgentJobStore methods). No applier exists yet; agent_apply/agent_diff/
 * agent_discard are not registered. See jobStore.ts for the exact semantics.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentJobStore, type NewAgentJob, type NewApplyAttempt } from '../../src/executor/agents/jobStore.js';
import { BridgeError } from '../../src/shared/errors.js';

let store: AgentJobStore;
let dbPath: string;
let seq = 0;

function newJob(over: Partial<NewAgentJob> = {}): NewAgentJob {
  seq += 1;
  const id = `job_${seq.toString(16).padStart(32, '0')}`;
  return {
    jobId: id,
    principalId: 'owner',
    backend: 'kiro',
    project: 'example-project',
    profile: 'implement',
    resourcePolicy: 'economy',
    promptHash: 'a'.repeat(64),
    prompt: 'do the thing',
    sessionPolicy: 'new',
    writer: true,
    ...over,
  };
}

/** attemptId defaults to a fresh sequence id; jobId must be overridden by the caller. */
function newAttempt(over: Partial<NewApplyAttempt> = {}): NewApplyAttempt {
  seq += 1;
  return {
    attemptId: `attempt_${seq.toString(16).padStart(32, '0')}`,
    jobId: `job_${seq.toString(16).padStart(32, '0')}`,
    ...over,
  };
}

/** Insert a job and drive it all the way to COMPLETED via the real CAS transitions. */
function completeJob(over: Partial<NewAgentJob> = {}): ReturnType<AgentJobStore['insert']> {
  const j = store.insert(newJob(over));
  store.transition(j.jobId, 'QUEUED', 'PREPARING', { startedAt: new Date().toISOString() });
  store.transition(j.jobId, 'PREPARING', 'RUNNING');
  store.transition(j.jobId, 'RUNNING', 'VALIDATING');
  store.transition(j.jobId, 'VALIDATING', 'COMPLETED', { completedAt: new Date().toISOString(), summary: 'ok', exitCode: 0 });
  return store.get(j.jobId)!;
}

function errCode(fn: () => unknown): string {
  try {
    fn();
    throw new Error('expected to throw');
  } catch (e) {
    if (e instanceof BridgeError) return e.code;
    throw e;
  }
}

beforeEach(() => {
  seq = 0;
  dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-apply-')), 'agents.db');
  store = new AgentJobStore(dbPath);
});

describe('A6-B1 project apply-admission state', () => {
  it('a project with no row is NORMAL / admission-allowed by default', () => {
    expect(store.isProjectApplyAllowed('never-seen-project')).toBe(true);
    expect(store.getProjectApplyState('never-seen-project')).toBeUndefined();
  });

  it('NORMAL project admits a first apply attempt', () => {
    const job = completeJob();
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    expect(attempt.state).toBe('STARTED');
    expect(attempt.jobId).toBe(job.jobId);
    expect(attempt.projectId).toBe(job.project);
  });
});

describe('A6-B1 apply attempt exclusivity (durable, DB-enforced)', () => {
  it('an active attempt (STARTED) blocks a second attempt for the SAME job', () => {
    const job = completeJob();
    store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    expect(() => store.startApplyAttempt(newAttempt({ jobId: job.jobId })))
      .toThrow(BridgeError);
    expect(errCode(() => store.startApplyAttempt(newAttempt({ jobId: job.jobId })))).toBe('APPLY_ATTEMPT_ACTIVE');
  });

  it('an active attempt blocks a second attempt for the SAME project even with a different job', () => {
    const jobA = completeJob({ project: 'shared-project' });
    const jobB = completeJob({ project: 'shared-project' });
    store.startApplyAttempt(newAttempt({ jobId: jobA.jobId }));
    expect(() => store.startApplyAttempt(newAttempt({ jobId: jobB.jobId })))
      .toThrow(/APPLY_ATTEMPT_ACTIVE|active/);
  });

  it('two DIFFERENT projects may each have their own independent active attempt', () => {
    const jobA = completeJob({ project: 'proj-a' });
    const jobB = completeJob({ project: 'proj-b' });
    const a = store.startApplyAttempt(newAttempt({ jobId: jobA.jobId }));
    const b = store.startApplyAttempt(newAttempt({ jobId: jobB.jobId }));
    expect(a.state).toBe('STARTED');
    expect(b.state).toBe('STARTED');
  });

  it('once an attempt reaches a terminal state, a new attempt for the same job/project is admitted', () => {
    const job = completeJob();
    const first = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    expect(store.transitionApplyAttempt(first.attemptId, 'STARTED', 'ABORTED_NO_MUTATION')).toBe(true);
    const second = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    expect(second.state).toBe('STARTED');
    expect(second.attemptId).not.toBe(first.attemptId);
  });
});

describe('A6-B1 QUARANTINED project admission', () => {
  it('a QUARANTINED project denies admission of a new apply attempt', () => {
    const orphaned = completeJob({ project: 'quarantine-me' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: orphaned.jobId }));
    expect(store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING')).toBe(true);
    expect(store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING')).toBe(true);
    // Simulate a crash mid-apply: recovery quarantines the project.
    store.recoverApplyAttempts('simulated crash');
    expect(store.getProjectApplyState('quarantine-me')!.state).toBe('QUARANTINED');

    const newJobSameProject = completeJob({ project: 'quarantine-me' });
    expect(() => store.startApplyAttempt(newAttempt({ jobId: newJobSameProject.jobId })))
      .toThrow(/PROJECT_QUARANTINED|quarantined/);
  });

  it('quarantine survives store restart', () => {
    const orphaned = completeJob({ project: 'restart-quarantine' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: orphaned.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('crash before restart');
    store.close();

    const reopened = new AgentJobStore(dbPath);
    expect(reopened.getProjectApplyState('restart-quarantine')!.state).toBe('QUARANTINED');
    expect(reopened.isProjectApplyAllowed('restart-quarantine')).toBe(false);
    reopened.close();
  });

  it('a QUARANTINED project remains inadmissible even though the UNCERTAIN attempt itself is terminal (no longer active)', () => {
    const orphaned = completeJob({ project: 'terminal-but-quarantined' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: orphaned.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('crash');
    // The UNCERTAIN attempt is terminal (not "active"), so exclusivity alone
    // would admit a new attempt — quarantine is the mechanism that still denies it.
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('UNCERTAIN');
    const another = completeJob({ project: 'terminal-but-quarantined' });
    expect(() => store.startApplyAttempt(newAttempt({ jobId: another.jobId })))
      .toThrow(/quarantined/);
  });
});

describe('A6-B1 restart recovery semantics', () => {
  it('orphaned STARTED recovers to ABORTED_NO_MUTATION with no quarantine', () => {
    const job = completeJob({ project: 'started-orphan' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    const result = store.recoverApplyAttempts('executor restarted');
    expect(result.abortedNoMutation).toEqual([attempt.attemptId]);
    expect(result.uncertain).toEqual([]);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('ABORTED_NO_MUTATION');
    expect(store.isProjectApplyAllowed('started-orphan')).toBe(true);
    expect(store.getProjectApplyState('started-orphan')).toBeUndefined();
  });

  it('orphaned VERIFYING recovers to ABORTED_NO_MUTATION with no quarantine', () => {
    const job = completeJob({ project: 'verifying-orphan' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    const result = store.recoverApplyAttempts('executor restarted');
    expect(result.abortedNoMutation).toEqual([attempt.attemptId]);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('ABORTED_NO_MUTATION');
    expect(store.isProjectApplyAllowed('verifying-orphan')).toBe(true);
  });

  it('orphaned APPLYING recovers to UNCERTAIN AND quarantines the owning project, in the same pass', () => {
    const job = completeJob({ project: 'applying-orphan' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    const result = store.recoverApplyAttempts('executor restarted mid-apply');
    expect(result.uncertain).toEqual([attempt.attemptId]);
    expect(result.abortedNoMutation).toEqual([]);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('UNCERTAIN');
    const projectState = store.getProjectApplyState('applying-orphan')!;
    expect(projectState.state).toBe('QUARANTINED');
    expect(projectState.quarantineCausingJobId).toBe(job.jobId);
    expect(projectState.quarantineCausingAttemptId).toBe(attempt.attemptId);
  });

  it('terminal attempts (VERIFIED_SUCCESS, ABORTED_NO_MUTATION, etc) are untouched by recovery', () => {
    const job = completeJob({ project: 'already-terminal' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'ABORTED_NO_MUTATION', { reason: 'precondition drift' });
    const result = store.recoverApplyAttempts('executor restarted');
    expect(result.abortedNoMutation).toEqual([]);
    expect(result.uncertain).toEqual([]);
    expect(store.getApplyAttempt(attempt.attemptId)!.reason).toBe('precondition drift');
  });

  it('UNCERTAIN is never automatically retried by the recovery sweep itself', () => {
    const job = completeJob({ project: 'never-retry' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('crash 1');
    // Re-running recovery again must be a no-op for this already-UNCERTAIN attempt.
    const again = store.recoverApplyAttempts('crash 2 (idempotent re-run)');
    expect(again.uncertain).toEqual([]);
    expect(again.abortedNoMutation).toEqual([]);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('UNCERTAIN');
  });

  it('recovery is idempotent and does not clobber an existing quarantine cause on re-run (same attempt)', () => {
    const jobA = completeJob({ project: 'multi-crash' });
    const attemptA = store.startApplyAttempt(newAttempt({ jobId: jobA.jobId }));
    store.transitionApplyAttempt(attemptA.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attemptA.attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('first crash');
    const firstQuarantine = store.getProjectApplyState('multi-crash')!;

    // A second, unrelated recovery pass must not change the original cause.
    store.recoverApplyAttempts('second unrelated recovery pass');
    const secondQuarantine = store.getProjectApplyState('multi-crash')!;
    expect(secondQuarantine.quarantinedAt).toBe(firstQuarantine.quarantinedAt);
    expect(secondQuarantine.quarantineCausingAttemptId).toBe(firstQuarantine.quarantineCausingAttemptId);
  });

  it('a second, genuinely NEW orphaned-APPLYING attempt for an already-quarantined project exercises the real ON CONFLICT branch and preserves the original cause', () => {
    const jobA = completeJob({ project: 'conflict-project' });
    const attemptA = store.startApplyAttempt(newAttempt({ jobId: jobA.jobId }));
    store.transitionApplyAttempt(attemptA.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attemptA.attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('first crash');
    const firstState = store.getProjectApplyState('conflict-project')!;
    expect(firstState.state).toBe('QUARANTINED');
    expect(firstState.quarantineCausingAttemptId).toBe(attemptA.attemptId);

    // Simulate a second, independent orphaned-APPLYING attempt for the SAME
    // project (e.g. a legacy inconsistency or a race that predates this
    // project's quarantine becoming durable). Inserted directly at the row
    // level — this deliberately bypasses startApplyAttempt()'s admission
    // checks (which would correctly refuse it) so the test isolates and
    // genuinely exercises the recoverApplyAttempts() INSERT ... ON CONFLICT
    // SQL branch, rather than re-running recovery over the SAME already-
    // terminal attempt (which never reaches the INSERT at all).
    const jobB = completeJob({ project: 'conflict-project' });
    const attemptBId = 'attempt_' + 'b'.repeat(32);
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`
      INSERT INTO agent_apply_attempts (attempt_id, job_id, project_id, state, started_at)
      VALUES (?, ?, 'conflict-project', 'APPLYING', ?)
    `).run(attemptBId, jobB.jobId, new Date().toISOString());
    raw.close();

    const result = store.recoverApplyAttempts('second legitimate crash');
    expect(result.uncertain).toEqual([attemptBId]);
    expect(store.getApplyAttempt(attemptBId)!.state).toBe('UNCERTAIN');

    // ON CONFLICT executed (project_id already had a row) — state remains
    // QUARANTINED and the ORIGINAL cause (attempt A / job A) is preserved,
    // never overwritten with attempt B's identity.
    const secondState = store.getProjectApplyState('conflict-project')!;
    expect(secondState.state).toBe('QUARANTINED');
    expect(secondState.quarantineCausingAttemptId).toBe(attemptA.attemptId);
    expect(secondState.quarantineCausingJobId).toBe(jobA.jobId);
    expect(secondState.quarantinedAt).toBe(firstState.quarantinedAt);
  });
});

describe('A6-B1 atomic success / discard primitives', () => {
  it('markApplySuccess atomically stores VERIFIED_SUCCESS + APPLIED + applied_at', () => {
    const job = completeJob();
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');

    expect(store.markApplySuccess(attempt.attemptId, job.jobId, { mutatedPathCount: 3 })).toBe(true);

    const updatedAttempt = store.getApplyAttempt(attempt.attemptId)!;
    const updatedJob = store.get(job.jobId)!;
    expect(updatedAttempt.state).toBe('VERIFIED_SUCCESS');
    expect(updatedAttempt.mutatedPathCount).toBe(3);
    expect(updatedJob.status).toBe('APPLIED');
    expect(updatedJob.appliedAt).not.toBeNull();
  });

  it('markApplySuccess is atomic: fails wholesale (no partial state) if the attempt is not APPLYING', () => {
    const job = completeJob();
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    // Attempt is still STARTED, not APPLYING — the primitive must refuse.
    expect(store.markApplySuccess(attempt.attemptId, job.jobId)).toBe(false);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('STARTED');
    expect(store.get(job.jobId)!.status).toBe('COMPLETED'); // unchanged
    expect(store.get(job.jobId)!.appliedAt).toBeNull();
  });

  it('markApplySuccess is atomic: fails wholesale if the job/attempt pairing does not resolve', () => {
    const job = completeJob();
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');

    // A still-QUEUED job (never reached COMPLETED) can never legally be the
    // target of a success primitive — the attempt->job pairing must resolve
    // to a job actually in COMPLETED, or nothing is written.
    const neverCompleted = store.insert(newJob());
    expect(store.markApplySuccess(attempt.attemptId, neverCompleted.jobId)).toBe(false);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('APPLYING'); // unchanged: rolled back
    expect(store.get(neverCompleted.jobId)!.status).toBe('QUEUED'); // unchanged
  });

  it('a restart after APPLIED returns the original applied_at unchanged', () => {
    const job = completeJob();
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    store.markApplySuccess(attempt.attemptId, job.jobId);
    const appliedAt = store.get(job.jobId)!.appliedAt;
    store.close();

    const reopened = new AgentJobStore(dbPath);
    expect(reopened.get(job.jobId)!.appliedAt).toBe(appliedAt);
    expect(reopened.get(job.jobId)!.status).toBe('APPLIED');
    reopened.close();
  });

  it('discardJob atomically stores DISCARDED + disposition_at', () => {
    const job = completeJob();
    expect(store.discardJob(job.jobId)).toBe(true);
    const updated = store.get(job.jobId)!;
    expect(updated.status).toBe('DISCARDED');
    expect(updated.dispositionAt).not.toBeNull();
  });

  it('discardJob refuses (no mutation) while an apply attempt is active for the job', () => {
    const job = completeJob();
    store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    expect(() => store.discardJob(job.jobId)).toThrow(/active apply attempt/);
    expect(store.get(job.jobId)!.status).toBe('COMPLETED'); // unchanged
  });

  it('discarding a job never clears an existing project quarantine', () => {
    const orphaned = completeJob({ project: 'discard-no-clear' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: orphaned.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('crash');
    expect(store.getProjectApplyState('discard-no-clear')!.state).toBe('QUARANTINED');

    const other = completeJob({ project: 'discard-no-clear' });
    store.discardJob(other.jobId);
    expect(store.getProjectApplyState('discard-no-clear')!.state).toBe('QUARANTINED'); // still quarantined
  });

  it('a restart after DISCARDED returns the original disposition_at unchanged', () => {
    const job = completeJob();
    store.discardJob(job.jobId);
    const dispositionAt = store.get(job.jobId)!.dispositionAt;
    store.close();

    const reopened = new AgentJobStore(dbPath);
    expect(reopened.get(job.jobId)!.dispositionAt).toBe(dispositionAt);
    expect(reopened.get(job.jobId)!.status).toBe('DISCARDED');
    reopened.close();
  });
});

describe('A6-B1 UNCERTAIN blocks discardJob (section 6, locked correction)', () => {
  it('discardJob rejects when the job itself has an UNCERTAIN apply attempt; job remains COMPLETED, quarantine unchanged', () => {
    const job = completeJob({ project: 'uncertain-discard' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('crash');
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('UNCERTAIN');

    expect(() => store.discardJob(job.jobId)).toThrow(BridgeError);
    expect(errCode(() => store.discardJob(job.jobId))).toBe('APPLY_ATTEMPT_UNCERTAIN');
    expect(store.get(job.jobId)!.status).toBe('COMPLETED'); // never disposed
    expect(store.get(job.jobId)!.dispositionAt).toBeNull();
    expect(store.getProjectApplyState('uncertain-discard')!.state).toBe('QUARANTINED'); // unchanged
  });

  it('discarding a DIFFERENT job for the same quarantined project still succeeds if that job has no UNCERTAIN attempt', () => {
    const uncertainJob = completeJob({ project: 'mixed-quarantine' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: uncertainJob.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('crash');
    expect(store.getProjectApplyState('mixed-quarantine')!.state).toBe('QUARANTINED');

    const cleanJob = completeJob({ project: 'mixed-quarantine' });
    expect(store.discardJob(cleanJob.jobId)).toBe(true);
    expect(store.get(cleanJob.jobId)!.status).toBe('DISCARDED');
    // Discard never clears quarantine, and further apply for this project
    // stays denied regardless of the unrelated job's disposition.
    expect(store.getProjectApplyState('mixed-quarantine')!.state).toBe('QUARANTINED');
    // The originally UNCERTAIN job itself is still blocked from discard too.
    expect(() => store.discardJob(uncertainJob.jobId)).toThrow(BridgeError);
  });
});

describe('A6-B1 internal transition legality', () => {
  it('rejects an illegal apply-attempt transition that hits the VERIFIED_SUCCESS special guard (documented, pre-existing coverage)', () => {
    const job = completeJob();
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    expect(() => store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFIED_SUCCESS')).toThrow(BridgeError);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('STARTED');
  });

  it('rejects a REAL state-matrix violation that reaches assertApplyAttemptTransition itself (not VERIFIED_SUCCESS/UNCERTAIN)', () => {
    const job = completeJob();
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    // STARTED -> FAILED_ROLLED_BACK is illegal per the matrix (FAILED_ROLLED_BACK
    // is only reachable from APPLYING) and is neither VERIFIED_SUCCESS nor
    // UNCERTAIN, so this must be rejected by assertApplyAttemptTransition()
    // itself, genuinely exercising the shared state matrix rather than the
    // earlier special-cased guard.
    expect(() => store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'FAILED_ROLLED_BACK')).toThrow(BridgeError);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('STARTED'); // unchanged
  });

  it('CAS reports a raced transition as false without changing state', () => {
    const job = completeJob();
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'ABORTED_NO_MUTATION');
    // A second caller racing on the stale expected-from value loses cleanly.
    expect(store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'PRECONDITION_FAILED')).toBe(false);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('ABORTED_NO_MUTATION');
  });

  it('refuses to drive VERIFIED_SUCCESS through the generic transition (must use markApplySuccess)', () => {
    const job = completeJob();
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    // A caller cannot bypass the atomic job-coupling by using the generic CAS.
    expect(() => store.transitionApplyAttempt(attempt.attemptId, 'APPLYING', 'VERIFIED_SUCCESS')).toThrow(BridgeError);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('APPLYING'); // unchanged
    expect(store.get(job.jobId)!.status).toBe('COMPLETED'); // unchanged
  });

  it('refuses to drive UNCERTAIN through the generic transition (must use recoverApplyAttempts, which also quarantines)', () => {
    const job = completeJob({ project: 'no-bypass-quarantine' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    // A caller cannot silently reach UNCERTAIN without the project being quarantined.
    expect(() => store.transitionApplyAttempt(attempt.attemptId, 'APPLYING', 'UNCERTAIN')).toThrow(BridgeError);
    expect(store.getApplyAttempt(attempt.attemptId)!.state).toBe('APPLYING'); // unchanged
    expect(store.isProjectApplyAllowed('no-bypass-quarantine')).toBe(true); // never desynchronized
  });
});

describe('A6-B1 D1: generic transition() cannot create disposition rows', () => {
  it('rejects a generic COMPLETED -> APPLIED transition with zero mutation', () => {
    const job = completeJob();
    expect(() => store.transition(job.jobId, 'COMPLETED', 'APPLIED')).toThrow(BridgeError);
    expect(errCode(() => store.transition(job.jobId, 'COMPLETED', 'APPLIED'))).toBe('INVALID_JOB_TRANSITION');
    const after = store.get(job.jobId)!;
    expect(after.status).toBe('COMPLETED');
    expect(after.appliedAt).toBeNull();
  });

  it('rejects a generic COMPLETED -> DISCARDED transition with zero mutation', () => {
    const job = completeJob();
    expect(() => store.transition(job.jobId, 'COMPLETED', 'DISCARDED')).toThrow(BridgeError);
    expect(errCode(() => store.transition(job.jobId, 'COMPLETED', 'DISCARDED'))).toBe('INVALID_JOB_TRANSITION');
    const after = store.get(job.jobId)!;
    expect(after.status).toBe('COMPLETED');
    expect(after.dispositionAt).toBeNull();
  });

  it('an active apply attempt cannot be bypassed via the generic transition to DISCARDED either', () => {
    const job = completeJob();
    store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    expect(() => store.transition(job.jobId, 'COMPLETED', 'DISCARDED')).toThrow(BridgeError);
    expect(store.get(job.jobId)!.status).toBe('COMPLETED');
  });

  it('markApplySuccess remains the ONLY path to APPLIED', () => {
    const job = completeJob();
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    store.transitionApplyAttempt(attempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attempt.attemptId, 'VERIFYING', 'APPLYING');
    expect(store.markApplySuccess(attempt.attemptId, job.jobId)).toBe(true);
    expect(store.get(job.jobId)!.status).toBe('APPLIED');
  });

  it('discardJob remains the ONLY path to DISCARDED', () => {
    const job = completeJob();
    expect(store.discardJob(job.jobId)).toBe(true);
    expect(store.get(job.jobId)!.status).toBe('DISCARDED');
  });

  it('ordinary non-disposition job lifecycle transitions still work through the generic transition() unaffected', () => {
    const j = store.insert(newJob());
    expect(store.transition(j.jobId, 'QUEUED', 'PREPARING', { startedAt: new Date().toISOString() })).toBe(true);
    expect(store.transition(j.jobId, 'PREPARING', 'RUNNING')).toBe(true);
    expect(store.transition(j.jobId, 'RUNNING', 'VALIDATING')).toBe(true);
    expect(store.transition(j.jobId, 'VALIDATING', 'COMPLETED', { completedAt: new Date().toISOString() })).toBe(true);
    expect(store.get(j.jobId)!.status).toBe('COMPLETED');
  });
});

describe('A6-B1 D2: startApplyAttempt derives ALL provenance from the durable job (no caller override)', () => {
  it('derives project, principal, base commit, and artifact hash from the durable job row', () => {
    const job = completeJob({ principalId: 'alice', project: 'derive-project' });
    store.setBaseCommit(job.jobId, 'b'.repeat(40));
    // artifact_hash has no public setter yet (later A6 runtime work) — poke
    // the column directly at the row level purely to prove derivation.
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE agent_jobs SET artifact_hash = ? WHERE job_id = ?').run('c'.repeat(64), job.jobId);
    raw.close();

    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    expect(attempt.projectId).toBe('derive-project');
    expect(attempt.principalId).toBe('alice');
    expect(attempt.baseCommit).toBe('b'.repeat(40));
    expect(attempt.expectedArtifactHash).toBe('c'.repeat(64));
  });

  it('the API surface accepts only attemptId and jobId — there is no project/principal/baseCommit/artifactHash parameter to restate', () => {
    const job = completeJob({ project: 'true-project', principalId: 'true-principal' });
    const attempt = store.startApplyAttempt({ attemptId: 'attempt_' + 'e'.repeat(32), jobId: job.jobId });
    expect(attempt.projectId).toBe('true-project');
    expect(attempt.principalId).toBe('true-principal');
  });

  it('rejects admission for a nonexistent job; no attempt row is created', () => {
    const bogusJobId = 'job_' + 'f'.repeat(32);
    expect(() => store.startApplyAttempt(newAttempt({ jobId: bogusJobId }))).toThrow(BridgeError);
    expect(errCode(() => store.startApplyAttempt(newAttempt({ jobId: bogusJobId })))).toBe('UNKNOWN_JOB');
    expect(store.listApplyAttemptsForJob(bogusJobId)).toEqual([]);
  });

  it('rejects admission for every non-COMPLETED public job status; no attempt row is created', () => {
    const queued = store.insert(newJob({ project: 'not-completed-1' }));
    expect(errCode(() => store.startApplyAttempt(newAttempt({ jobId: queued.jobId })))).toBe('PRECONDITION_FAILED');
    expect(store.listApplyAttemptsForJob(queued.jobId)).toEqual([]);

    const preparing = store.insert(newJob({ project: 'not-completed-2' }));
    store.transition(preparing.jobId, 'QUEUED', 'PREPARING', { startedAt: new Date().toISOString() });
    expect(errCode(() => store.startApplyAttempt(newAttempt({ jobId: preparing.jobId })))).toBe('PRECONDITION_FAILED');

    const failed = store.insert(newJob({ project: 'not-completed-3' }));
    store.transition(failed.jobId, 'QUEUED', 'FAILED_PRECONDITION', { completedAt: new Date().toISOString(), failureCode: 'FAILED_PRECONDITION' });
    expect(errCode(() => store.startApplyAttempt(newAttempt({ jobId: failed.jobId })))).toBe('PRECONDITION_FAILED');

    const discarded = completeJob({ project: 'not-completed-4' });
    store.discardJob(discarded.jobId);
    expect(errCode(() => store.startApplyAttempt(newAttempt({ jobId: discarded.jobId })))).toBe('PRECONDITION_FAILED');

    const applied = completeJob({ project: 'not-completed-5' });
    const appliedAttempt = store.startApplyAttempt(newAttempt({ jobId: applied.jobId }));
    store.transitionApplyAttempt(appliedAttempt.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(appliedAttempt.attemptId, 'VERIFYING', 'APPLYING');
    store.markApplySuccess(appliedAttempt.attemptId, applied.jobId);
    expect(errCode(() => store.startApplyAttempt(newAttempt({ jobId: applied.jobId })))).toBe('PRECONDITION_FAILED');
  });

  it('a job\'s stored quarantine blocks admission even though the caller never restates its project (relabelling is structurally impossible)', () => {
    const orphaned = completeJob({ project: 'quarantine-target' });
    const first = store.startApplyAttempt(newAttempt({ jobId: orphaned.jobId }));
    store.transitionApplyAttempt(first.attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(first.attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('crash');
    expect(store.getProjectApplyState('quarantine-target')!.state).toBe('QUARANTINED');

    const anotherJob = completeJob({ project: 'quarantine-target' });
    expect(errCode(() => store.startApplyAttempt(newAttempt({ jobId: anotherJob.jobId })))).toBe('PROJECT_QUARANTINED');
  });
});

describe('A6-B1 duplicate attempt id vs active collision classification', () => {
  it('a duplicate attemptId for the SAME job is classified as DUPLICATE_ATTEMPT_ID, not APPLY_ATTEMPT_ACTIVE', () => {
    const job = completeJob({ project: 'dup-id-project' });
    const attempt = store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    expect(errCode(() => store.startApplyAttempt({ attemptId: attempt.attemptId, jobId: job.jobId }))).toBe('DUPLICATE_ATTEMPT_ID');
  });

  it('a duplicate attemptId reused for a DIFFERENT (unrelated, still-COMPLETED) job is also classified as DUPLICATE_ATTEMPT_ID', () => {
    const jobA = completeJob({ project: 'dup-id-project-a' });
    const jobB = completeJob({ project: 'dup-id-project-b' });
    const attemptA = store.startApplyAttempt(newAttempt({ jobId: jobA.jobId }));
    expect(errCode(() => store.startApplyAttempt({ attemptId: attemptA.attemptId, jobId: jobB.jobId }))).toBe('DUPLICATE_ATTEMPT_ID');
  });

  it('a DIFFERENT attemptId for the same already-active job/project is classified as APPLY_ATTEMPT_ACTIVE, not DUPLICATE_ATTEMPT_ID', () => {
    const job = completeJob({ project: 'active-collision-project' });
    store.startApplyAttempt(newAttempt({ jobId: job.jobId }));
    expect(errCode(() => store.startApplyAttempt(newAttempt({ jobId: job.jobId })))).toBe('APPLY_ATTEMPT_ACTIVE');
  });
});

describe('A6-B1 foreign key: agent_apply_attempts.job_id -> agent_jobs.job_id', () => {
  it('the foreign key constraint exists in the schema', () => {
    const raw = new DatabaseSync(dbPath);
    const fks = raw.prepare('PRAGMA foreign_key_list(agent_apply_attempts)').all() as { table: string; from: string; to: string }[];
    raw.close();
    const fk = fks.find((f) => f.from === 'job_id');
    expect(fk, 'job_id foreign key must exist on agent_apply_attempts').toBeTruthy();
    expect(fk!.table).toBe('agent_jobs');
    expect(fk!.to).toBe('job_id');
  });

  it('the DB rejects a dangling attempt job_id at the row level (defense in depth)', () => {
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA foreign_keys=ON');
    const danglingJobId = 'job_' + 'd'.repeat(32); // well-formed but never inserted into agent_jobs
    expect(() => raw.prepare(`
      INSERT INTO agent_apply_attempts (attempt_id, job_id, project_id, state, started_at)
      VALUES ('attempt_dangling', ?, 'proj', 'STARTED', ?)
    `).run(danglingJobId, new Date().toISOString())).toThrow();
    raw.close();
  });

  it('foreign key checks pass cleanly for a well-formed, real job/attempt pair', () => {
    const job = completeJob({ project: 'fk-happy-path' });
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA foreign_keys=ON');
    const result = raw.prepare('PRAGMA foreign_key_check(agent_apply_attempts)').all();
    raw.close();
    expect(result).toEqual([]);
    // Sanity: a real attempt for this job still succeeds through the store.
    expect(store.startApplyAttempt(newAttempt({ jobId: job.jobId })).jobId).toBe(job.jobId);
  });
});

describe('A6-B1 regression: schema stays v3 through B1 remediation', () => {
  it('schema version is at least v3 (B1 apply-state tables present) after all B1 remediation changes', () => {
    // A6-B5 additively bumped the schema to v4 (agent_apply_journal table).
    // This regression's intent — B1's apply-state tables are present and
    // untouched by later remediation — still holds; it no longer pins the
    // exact version number, since a later additive bump is expected and
    // correct (see PHASE_A6_B5_AGENT_APPLY.md §8).
    expect(store.schemaVersion).toBeGreaterThanOrEqual(3);
  });
});
