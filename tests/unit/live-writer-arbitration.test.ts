import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentJobStore, type NewAgentJob } from '../../src/executor/agents/jobStore.js';
import { AGENT_RETENTION_DURATION_MS } from '../../src/shared/agents.js';
import { BridgeError } from '../../src/shared/errors.js';
import { LIVE_WRITER_LEASE_ID_PATTERN } from '../../src/shared/liveWriter.js';

let store: AgentJobStore;
let dbPath: string;
let seq=0;

const ideOwner=(hex='a')=>`ideo_${hex.repeat(32)}`;
const attemptOwner=(hex='b')=>`att_${hex.repeat(32)}`;
const err=(fn:()=>unknown):string=>{try{fn();throw new Error('expected error');}catch(e){if(e instanceof BridgeError)return e.code;throw e;}};

function completed(project='proj',principalId='owner'){
  seq+=1; const jobId=`job_${seq.toString(16).padStart(32,'0')}`;
  const input:NewAgentJob={jobId,principalId,backend:'kiro',project,profile:'implement',resourcePolicy:'economy',promptHash:'a'.repeat(64),prompt:'x',sessionPolicy:'new',writer:true,retentionClass:'ephemeral',retentionDurationMs:AGENT_RETENTION_DURATION_MS.ephemeral};
  store.insert(input); store.transition(jobId,'QUEUED','PREPARING',{startedAt:new Date().toISOString()}); store.transition(jobId,'PREPARING','RUNNING'); store.transition(jobId,'RUNNING','VALIDATING'); store.transition(jobId,'VALIDATING','COMPLETED',{completedAt:new Date().toISOString()});
  return store.get(jobId)!;
}
function ideInput(over:Partial<{projectId:string;worktreeId:string;ownerId:string;principalId:string}>={}){return{projectId:over.projectId??'proj',worktreeId:over.worktreeId??'main',ownerKind:'ide' as const,ownerId:over.ownerId??ideOwner(),principalId:over.principalId??'owner'};}

beforeEach(()=>{seq=0;dbPath=join(mkdtempSync(join(tmpdir(),'qg-b8-')),'agents.db');store=new AgentJobStore(dbPath);});

describe('P7 B8 shared live-worktree writer arbitration',()=>{
  it('creates an opaque exact-bound IDE lease and refuses binding substitution',()=>{
    const input=ideInput(); const lease=store.acquireLiveWriterLease(input);
    expect(lease.writerLeaseId).toMatch(LIVE_WRITER_LEASE_ID_PATTERN); expect(lease).toMatchObject({...input,state:'ACTIVE'});
    expect(err(()=>store.releaseLiveWriterLease({...input,projectId:'other',writerLeaseId:lease.writerLeaseId}))).toBe('LIVE_WRITER_BINDING_MISMATCH');
    expect(store.getLiveWriterLease(lease.writerLeaseId)?.state).toBe('ACTIVE');
  });

  it('allows only one held writer for one exact project/worktree across IDE and agent_apply lanes',()=>{
    const ide=ideInput(); const lease=store.acquireLiveWriterLease(ide); const job=completed('proj');
    expect(err(()=>store.startApplyAttempt({attemptId:attemptOwner(),jobId:job.jobId,worktreeId:'main'}))).toBe('LIVE_WRITER_BUSY');
    expect(store.listApplyAttemptsForJob(job.jobId)).toEqual([]);
    expect(store.getLiveWriterLease(lease.writerLeaseId)?.state).toBe('ACTIVE');
  });

  it('an admitted agent_apply lease blocks IDE acquisition on the same target but not another worktree',()=>{
    const job=completed('proj'); const attempt=store.startApplyAttempt({attemptId:attemptOwner(),jobId:job.jobId,worktreeId:'main'});
    expect(attempt.writerLeaseId).toMatch(LIVE_WRITER_LEASE_ID_PATTERN);
    expect(err(()=>store.acquireLiveWriterLease(ideInput({ownerId:ideOwner('c')})))).toBe('LIVE_WRITER_BUSY');
    expect(()=>store.acquireLiveWriterLease(ideInput({worktreeId:'other',ownerId:ideOwner('d')}))).not.toThrow();
  });

  it('safe release permits the next lane, while UNCERTAIN remains permanently blocking',()=>{
    const first=ideInput(); const lease=store.acquireLiveWriterLease(first);
    expect(store.releaseLiveWriterLease({...first,writerLeaseId:lease.writerLeaseId,reason:'done'})).toBe(true);
    expect(store.acquireLiveWriterLease(ideInput({ownerId:ideOwner('b')})).state).toBe('ACTIVE');

    const blocked=ideInput({projectId:'p2',worktreeId:'main',ownerId:ideOwner('c')}); const held=store.acquireLiveWriterLease(blocked);
    expect(store.markLiveWriterUncertain({...blocked,writerLeaseId:held.writerLeaseId,reason:'crash'})).toBe(true);
    expect(err(()=>store.acquireLiveWriterLease(ideInput({projectId:'p2',worktreeId:'main',ownerId:ideOwner('d')})))).toBe('LIVE_WRITER_BUSY');
    expect(err(()=>store.releaseLiveWriterLease({...blocked,writerLeaseId:held.writerLeaseId}))).toBe('LIVE_WRITER_UNCERTAIN');
  });

  it('owner identities are one-use and agent_apply cannot bypass its atomic apply wrapper',()=>{
    const input=ideInput(); const lease=store.acquireLiveWriterLease(input); store.releaseLiveWriterLease({...input,writerLeaseId:lease.writerLeaseId});
    expect(err(()=>store.acquireLiveWriterLease(input))).toBe('LIVE_WRITER_BINDING_MISMATCH');
    expect(err(()=>store.acquireLiveWriterLease({projectId:'proj',worktreeId:'main',ownerKind:'agent_apply',ownerId:attemptOwner(),principalId:'owner'}))).toBe('PRECONDITION_FAILED');
  });

  it('safe apply terminal states release the shared lease atomically',()=>{
    const job=completed('proj'); const a=store.startApplyAttempt({attemptId:attemptOwner(),jobId:job.jobId,worktreeId:'main'});
    expect(store.getLiveWriterLease(a.writerLeaseId!)?.state).toBe('ACTIVE');
    store.transitionApplyAttempt(a.attemptId,'STARTED','VERIFYING'); store.transitionApplyAttempt(a.attemptId,'VERIFYING','PRECONDITION_FAILED',{reason:'safe'});
    expect(store.getLiveWriterLease(a.writerLeaseId!)?.state).toBe('RELEASED');
    expect(()=>store.acquireLiveWriterLease(ideInput())).not.toThrow();
  });

  it('VERIFIED_SUCCESS releases the live writer; FAILED_ROLLED_BACK also releases it',()=>{
    const job=completed('proj'); const a=store.startApplyAttempt({attemptId:attemptOwner('1'),jobId:job.jobId,worktreeId:'main'});
    store.transitionApplyAttempt(a.attemptId,'STARTED','VERIFYING'); store.transitionApplyAttempt(a.attemptId,'VERIFYING','APPLYING');
    expect(store.markApplySuccess(a.attemptId,job.jobId)).toBe(true); expect(store.getLiveWriterLease(a.writerLeaseId!)?.state).toBe('RELEASED');

    const job2=completed('proj2'); const b=store.startApplyAttempt({attemptId:attemptOwner('2'),jobId:job2.jobId,worktreeId:'main'});
    store.transitionApplyAttempt(b.attemptId,'STARTED','VERIFYING'); store.transitionApplyAttempt(b.attemptId,'VERIFYING','APPLYING');
    store.transitionApplyAttempt(b.attemptId,'APPLYING','FAILED_ROLLED_BACK',{reason:'verified rollback'});
    expect(store.getLiveWriterLease(b.writerLeaseId!)?.state).toBe('RELEASED');
  });

  it('rejects project substitution when marking an apply UNCERTAIN and preserves the active lease',()=>{
    const job=completed('truth');
    const a=store.startApplyAttempt({attemptId:attemptOwner('6'),jobId:job.jobId,worktreeId:'main'});
    store.transitionApplyAttempt(a.attemptId,'STARTED','VERIFYING');
    store.transitionApplyAttempt(a.attemptId,'VERIFYING','APPLYING');
    expect(err(()=>store.markApplyUncertain(a.attemptId,job.jobId,'forged','wrong project'))).toBe('LIVE_WRITER_BINDING_MISMATCH');
    expect(store.getApplyAttempt(a.attemptId)?.state).toBe('APPLYING');
    expect(store.getLiveWriterLease(a.writerLeaseId!)?.state).toBe('ACTIVE');
    expect(store.getProjectApplyState('truth')).toBeUndefined();
    expect(store.getProjectApplyState('forged')).toBeUndefined();
  });

  it('restart recovery releases proven-zero-mutation apply leases and makes APPLYING/IDE leases UNCERTAIN',()=>{
    const safeJob=completed('safe'); const safe=store.startApplyAttempt({attemptId:attemptOwner('3'),jobId:safeJob.jobId,worktreeId:'main'});
    const unsafeJob=completed('unsafe'); const unsafe=store.startApplyAttempt({attemptId:attemptOwner('4'),jobId:unsafeJob.jobId,worktreeId:'main'});
    store.transitionApplyAttempt(unsafe.attemptId,'STARTED','VERIFYING'); store.transitionApplyAttempt(unsafe.attemptId,'VERIFYING','APPLYING');
    const ide=ideInput({projectId:'ideproj',ownerId:ideOwner('5')}); const ideLease=store.acquireLiveWriterLease(ide);
    const recovered=store.recoverApplyAttempts('restart');
    expect(recovered.abortedNoMutation).toContain(safe.attemptId); expect(store.getLiveWriterLease(safe.writerLeaseId!)?.state).toBe('RELEASED');
    expect(recovered.uncertain).toContain(unsafe.attemptId); expect(store.getLiveWriterLease(unsafe.writerLeaseId!)?.state).toBe('UNCERTAIN');
    expect(recovered.uncertainWriterLeaseIds).toContain(ideLease.writerLeaseId); expect(store.getLiveWriterLease(ideLease.writerLeaseId)?.state).toBe('UNCERTAIN');
    expect(store.getProjectApplyState('unsafe')?.state).toBe('QUARANTINED');
  });

  it('v8 durable writer schema stores logical authority only, never hostPath',()=>{
    const db=new DatabaseSync(dbPath); const cols=db.prepare('PRAGMA table_info(live_writer_leases)').all() as Array<{name:string}>; db.close();
    expect(cols.map(c=>c.name)).toEqual(['writer_lease_id','project_id','worktree_id','owner_kind','owner_id','principal_id','state','acquired_at','finished_at','reason']);
    expect(cols.some(c=>/path|host/i.test(c.name))).toBe(false);
  });
});
