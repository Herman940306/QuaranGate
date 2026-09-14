/**
 * P7 B9.2 backend-neutral mutation-capable IDE operation coordinator.
 *
 * This layer owns no filesystem/terminal/host-path API. It binds an already
 * authenticated B9.1 request to durable Plane-B operation state and the exact
 * durable B8 writer lease before invoking a mutation-capable adapter seam.
 */
import { hashIdeCompanionPayload, type IdeCompanionAuthEnvelope } from '../../shared/ideCompanionAuth.js';
import { serializeIdeCompanionImplementationPayload } from '../../shared/ideCompanionOperations.js';
import type { IdeOperationEvent } from '../../shared/ideSessions.js';
import { AgentJobStore, type LiveWriterLeaseRow } from '../agents/jobStore.js';
import type { AdmittedIdeImplementation } from './ideImplementationAdmission.js';
import { admitIdeImplementation } from './ideImplementationAdmission.js';
import type { IdeCompanionRuntimeRef } from './ideCompanionRuntime.js';
import { admitIdeCompanionRuntimeRequest } from './ideCompanionRuntimeAdmission.js';
import {
  IdeRegistryStoreError,
  IdeSessionStore,
  type IdeOperationRow,
  type IdeSessionRegistryKey,
} from './ideSessionStore.js';

export const IDE_IMPLEMENTATION_OPERATION_MAX_RUNTIME_MS = 10 * 60 * 1000;
export type IdeImplementationAdapterEventType = 'assistant_chunk'|'tool_activity'|'status';
export const IDE_IMPLEMENTATION_ADAPTER_OUTCOMES = [
  'completed', 'failed_no_mutation', 'failed_rolled_back',
  'cancelled_no_mutation', 'cancelled_rolled_back', 'indeterminate',
] as const;
export type IdeImplementationAdapterOutcome = (typeof IDE_IMPLEMENTATION_ADAPTER_OUTCOMES)[number];

export interface IdeImplementationAdapterInput {
  operationId: string;
  sessionId: string;
  connectionGeneration: number;
  prompt: string;
  signal: AbortSignal;
  emit: (type: IdeImplementationAdapterEventType, message?: string) => void;
}
export interface IdeImplementationOperationAdapter {
  run(input: IdeImplementationAdapterInput): Promise<{ outcome: IdeImplementationAdapterOutcome }>;
}
export interface IdeImplementationCoordinatorOptions {
  store: IdeSessionStore;
  writerStore: AgentJobStore;
  runtime: IdeCompanionRuntimeRef;
  adapter: IdeImplementationOperationAdapter;
  nowMs?: () => number;
  maxRuntimeMs?: number;
}
export class IdeImplementationCoordinatorError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name='IdeImplementationCoordinatorError'; }
}
interface ActiveImplementation {
  operationId:string; sessionId:string; connectionGeneration:number; controllerLeaseId:string;
  writerLeaseId:string; nextSequence:number; controller:AbortController; timer:NodeJS.Timeout;
  sink:(event:IdeOperationEvent)=>void;
}

export class IdeImplementationCoordinator {
  private readonly active=new Map<string,ActiveImplementation>();
  private readonly clock:()=>number;
  private readonly maxRuntimeMs:number;
  constructor(private readonly opts:IdeImplementationCoordinatorOptions){
    this.clock=opts.nowMs??(()=>Date.now()); this.maxRuntimeMs=opts.maxRuntimeMs??IDE_IMPLEMENTATION_OPERATION_MAX_RUNTIME_MS;
    if(!Number.isSafeInteger(this.maxRuntimeMs)||this.maxRuntimeMs<1||this.maxRuntimeMs>IDE_IMPLEMENTATION_OPERATION_MAX_RUNTIME_MS){
      throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_RUNTIME_INVALID','implementation runtime bound is invalid');
    }
  }

  startImplementation(envelope:IdeCompanionAuthEnvelope,prompt:string,workspaceAttestation:string,sink:(event:IdeOperationEvent)=>void):IdeOperationRow{
    if(envelope.capability!=='request_implementation') throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_CAPABILITY_DENIED','implementation start requires request_implementation');
    const admitted=admitIdeImplementation({ideStore:this.opts.store,writerStore:this.opts.writerStore,runtime:this.opts.runtime,envelope,prompt,workspaceAttestation,nowMs:this.clock()});
    const authenticatedPayload=serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation);
    let operation:IdeOperationRow;
    try{
      operation=this.opts.store.startImplementationOperation({
        ...admitted,runtimeInstanceId:this.opts.runtime.runtimeInstanceId,adapterId:this.opts.runtime.adapterId,adapterVersion:this.opts.runtime.adapterVersion,
        payloadSha256:admitted.payloadSha256,payloadBytes:Buffer.byteLength(authenticatedPayload,'utf8'),writerLeaseId:admitted.writerLeaseId,
      });
    }catch(error){
      this.settleAdmittedWithoutOperation(admitted,'RELEASED','implementation operation failed before durable start');
      throw error;
    }
    const started:IdeOperationEvent={version:1,operationId:operation.operationId,sessionId:operation.sessionId,connectionGeneration:operation.connectionGeneration,origin:'machine',sequence:0,type:'operation_started'};
    const controller=new AbortController();
    const active:ActiveImplementation={operationId:operation.operationId,sessionId:operation.sessionId,connectionGeneration:operation.connectionGeneration,controllerLeaseId:envelope.controllerLeaseId,writerLeaseId:admitted.writerLeaseId,nextSequence:1,controller,timer:setTimeout(()=>this.timeout(operation.operationId),this.maxRuntimeMs),sink};
    this.active.set(operation.operationId,active);
    try{sink(started);}catch(error){
      clearTimeout(active.timer); this.safeTerminal(active,'failed'); this.active.delete(operation.operationId); throw error;
    }
    try{
      this.requireExactActiveWriter(operation);
      this.opts.store.markImplementationMutationStarted(operation.operationId,admitted.writerLeaseId,envelope.controllerLeaseId);
    }catch(error){
      clearTimeout(active.timer); this.safeTerminal(active,'failed'); this.active.delete(operation.operationId); throw error;
    }
    void this.runAdapter(active,prompt);
    return this.opts.store.getOperation(operation.operationId)!;
  }

  cancel(envelope:IdeCompanionAuthEnvelope):'accepted'|'indeterminate'{
    if(envelope.capability!=='cancel') throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_CAPABILITY_DENIED','implementation cancel requires cancel capability');
    const admitted=admitIdeCompanionRuntimeRequest({store:this.opts.store,runtime:this.opts.runtime,envelope,payload:'',nowMs:this.clock()});
    const operation=this.opts.store.requestOperationCancellation(admitted);
    if(operation.capability!=='request_implementation') throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_BINDING_MISMATCH','cancel target is not an implementation operation');
    const active=this.active.get(operation.operationId);
    if(!active){
      const proven=this.settleWriterAuthority(operation,'UNCERTAIN','implementation cancellation lost in-process mutation handle');
      if(proven!=='UNCERTAIN') throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_CONFLICT','lost implementation handle did not retain writer uncertainty');
      this.opts.store.finalizeImplementationUncertainTerminal(operation.operationId,this.opts.writerStore,operation.writerLeaseId!,admitted.controllerLeaseId,'indeterminate');
      return'indeterminate';
    }
    active.controller.abort(new Error('implementation operation cancellation requested'));
    return'accepted';
  }

  /** Future transport seam: call before/with durable session disconnect. */
  connectionClosed(sessionId:string,connectionGeneration:number):void{
    for(const active of [...this.active.values()]){
      if(active.sessionId!==sessionId||active.connectionGeneration!==connectionGeneration)continue;
      clearTimeout(active.timer);
      const current=this.opts.store.getOperation(active.operationId);
      if(current&&(current.state==='RUNNING'||current.state==='CANCELLING')){try{this.unsafeTerminal(active,'disconnected');}catch{/* B8 remains ACTIVE/UNCERTAIN and therefore fail-closed */}}
      active.controller.abort(new Error('IDE implementation connection disconnected'));
      this.active.delete(active.operationId);
    }
  }

  /** Reconcile revocation/disconnect/restart terminalization performed by Plane-B lifecycle code. */
  reconcileTerminalWriterSettlements():string[]{
    const settled:string[]=[];
    for(const op of this.opts.store.listImplementationOperationsWithHeldWriter()){
      if(op.state==='RUNNING'||op.state==='CANCELLING')continue;
      if(op.writerLeaseId===null)throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_BINDING','terminal implementation operation lacks writer lease');
      const existing=this.opts.writerStore.getLiveWriterLease(op.writerLeaseId);
      let proven:'RELEASED'|'UNCERTAIN';
      if(existing?.state==='RELEASED')proven='RELEASED';
      else if(existing?.state==='UNCERTAIN')proven='UNCERTAIN';
      else proven=this.settleWriterAuthority(op,'UNCERTAIN',`reconcile terminal implementation operation ${op.state}`);
      this.opts.store.markImplementationWriterSettlement(op.operationId,this.opts.writerStore,op.writerLeaseId,proven);
      settled.push(op.operationId);
    }
    return settled;
  }

  /** B7 restart terminalization + B9.2 writer uncertainty. Global B8 recovery remains a separate accepted startup primitive. */
  recoverAfterRestart():{staledSessionIds:string[];indeterminateOperationIds:string[];writerReconciledOperationIds:string[]}{
    const recovered=this.opts.store.recoverAfterRestart();
    const writerReconciledOperationIds=this.reconcileTerminalWriterSettlements();
    return{...recovered,writerReconciledOperationIds};
  }

  private async runAdapter(active:ActiveImplementation,prompt:string):Promise<void>{
    try{
      const raw=await this.opts.adapter.run({operationId:active.operationId,sessionId:active.sessionId,connectionGeneration:active.connectionGeneration,prompt,signal:active.controller.signal,emit:(type,message)=>this.adapterEvent(active,type,message)});
      const outcome=this.parseOutcome(raw);
      const current=this.opts.store.getOperation(active.operationId);
      if(!current||!['RUNNING','CANCELLING'].includes(current.state))return;
      if(current.state==='CANCELLING'||active.controller.signal.aborted){
        if(outcome==='cancelled_no_mutation'||outcome==='cancelled_rolled_back') this.safeTerminal(active,'cancelled');
        else if(outcome==='failed_no_mutation'||outcome==='failed_rolled_back') this.safeTerminal(active,'failed');
        else this.unsafeTerminal(active,'indeterminate');
      }else if(outcome==='completed') this.safeTerminal(active,'completed');
      else if(outcome==='failed_no_mutation'||outcome==='failed_rolled_back') this.safeTerminal(active,'failed');
      else this.unsafeTerminal(active,'indeterminate');
    }catch{
      const current=this.opts.store.getOperation(active.operationId);
      if(current&&(current.state==='RUNNING'||current.state==='CANCELLING')){try{this.unsafeTerminal(active,'indeterminate');}catch{/* unresolved writer remains blocking */}}
    }finally{
      clearTimeout(active.timer); if(this.active.get(active.operationId)===active)this.active.delete(active.operationId);
    }
  }

  private adapterEvent(active:ActiveImplementation,type:IdeImplementationAdapterEventType,message?:string):void{
    if(active.controller.signal.aborted)return;
    const event:IdeOperationEvent={version:1,operationId:active.operationId,sessionId:active.sessionId,connectionGeneration:active.connectionGeneration,origin:'machine',sequence:active.nextSequence,type,...(message===undefined?{}:{message})};
    try{this.opts.store.appendOperationEvent(event,active.controllerLeaseId);active.nextSequence+=1;active.sink(event);}catch{active.controller.abort(new Error('durable implementation event rejected'));}
  }

  private safeTerminal(active:ActiveImplementation,type:'completed'|'cancelled'|'failed'):void{
    const current=this.opts.store.getOperation(active.operationId); if(!current||!['RUNNING','CANCELLING'].includes(current.state))return;
    const intent=type==='completed'?'COMPLETED':type==='cancelled'?'CANCELLED':'FAILED';
    const prepared=this.opts.store.prepareImplementationSafeTerminal(active.operationId,active.writerLeaseId,active.controllerLeaseId,intent);
    const event=this.terminalEvent(prepared,type);
    const proven=this.settleWriterAuthority(prepared,'RELEASED',`implementation operation safely ended ${intent}`);
    if(proven==='RELEASED'){
      this.opts.store.finalizeImplementationSafeTerminal(active.operationId,this.opts.writerStore,active.writerLeaseId,active.controllerLeaseId);
      try{active.sink(event);}catch{/* durable safe terminal + RELEASED writer are authoritative */}
      return;
    }
    const indeterminate=this.terminalEvent(prepared,'indeterminate');
    this.opts.store.finalizeImplementationUncertainTerminal(active.operationId,this.opts.writerStore,active.writerLeaseId,active.controllerLeaseId,'indeterminate');
    try{active.sink(indeterminate);}catch{/* durable indeterminate + UNCERTAIN writer are authoritative */}
  }
  private unsafeTerminal(active:ActiveImplementation,type:'indeterminate'|'disconnected'):void{
    const current=this.opts.store.getOperation(active.operationId); if(!current||!['RUNNING','CANCELLING'].includes(current.state))return;
    const proven=this.settleWriterAuthority(current,'UNCERTAIN',`implementation operation became ${type}`);
    if(proven!=='UNCERTAIN')throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_CONFLICT','unsafe implementation terminal did not retain writer uncertainty');
    const event=this.terminalEvent(current,type);
    this.opts.store.finalizeImplementationUncertainTerminal(active.operationId,this.opts.writerStore,active.writerLeaseId,active.controllerLeaseId,type);
    try{active.sink(event);}catch{/* durable unsafe terminal + UNCERTAIN writer are authoritative */}
  }
  private terminalEvent(op:IdeOperationRow,type:'completed'|'cancelled'|'failed'|'indeterminate'|'disconnected'):IdeOperationEvent{
    return{version:1,operationId:op.operationId,sessionId:op.sessionId,connectionGeneration:op.connectionGeneration,origin:'machine',sequence:op.nextSequence,type};
  }
  private timeout(operationId:string):void{
    const active=this.active.get(operationId); if(!active)return;
    const current=this.opts.store.getOperation(operationId); if(current&&['RUNNING','CANCELLING'].includes(current.state)){try{this.unsafeTerminal(active,'indeterminate');}catch{/* unresolved writer remains blocking */}}
    active.controller.abort(new Error('implementation operation runtime exceeded')); this.active.delete(operationId);
  }
  private parseOutcome(value:unknown):IdeImplementationAdapterOutcome{
    if(typeof value!=='object'||value===null||Array.isArray(value))throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_ADAPTER_RESULT_INVALID','implementation adapter result is invalid');
    const row=value as Record<string,unknown>; if(Object.keys(row).length!==1||typeof row.outcome!=='string'||!(IDE_IMPLEMENTATION_ADAPTER_OUTCOMES as readonly string[]).includes(row.outcome))throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_ADAPTER_RESULT_INVALID','implementation adapter result is invalid');
    return row.outcome as IdeImplementationAdapterOutcome;
  }
  private requireExactActiveWriter(op:IdeOperationRow):LiveWriterLeaseRow{
    if(op.writerLeaseId===null)throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_BINDING','implementation operation lacks writer lease');
    const lease=this.opts.writerStore.getLiveWriterLease(op.writerLeaseId);
    if(!lease||lease.state!=='ACTIVE'||lease.ownerKind!=='ide'||lease.ownerId!==op.operationId||lease.principalId!==op.principalId||lease.projectId!==op.projectId||lease.worktreeId!==op.worktreeId){
      throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_BINDING','durable B8 writer authority is not exact and ACTIVE');
    }
    return lease;
  }
  private settleAdmittedWithoutOperation(admitted:AdmittedIdeImplementation,target:'RELEASED'|'UNCERTAIN',reason:string):void{
    const binding={projectId:admitted.projectId,worktreeId:admitted.worktreeId,ownerKind:'ide' as const,ownerId:admitted.operationId,principalId:admitted.principalId,writerLeaseId:admitted.writerLeaseId};
    try{if(target==='RELEASED')this.opts.writerStore.releaseLiveWriterLease({...binding,reason});else this.opts.writerStore.markLiveWriterUncertain({...binding,reason});}
    catch(error){
      if(target==='RELEASED')try{this.opts.writerStore.markLiveWriterUncertain({...binding,reason:'pre-operation release could not be proven'});}catch{}
      throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_SETTLEMENT_FAILED','pre-operation writer settlement could not be proven');
    }
  }
  private settleWriterAuthority(op:IdeOperationRow,target:'RELEASED'|'UNCERTAIN',reason:string):'RELEASED'|'UNCERTAIN'{
    if(op.capability!=='request_implementation'||op.writerLeaseId===null)throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_BINDING','operation lacks implementation writer provenance');
    const binding={projectId:op.projectId,worktreeId:op.worktreeId,ownerKind:'ide' as const,ownerId:op.operationId,principalId:op.principalId,writerLeaseId:op.writerLeaseId};
    let lease=this.opts.writerStore.getLiveWriterLease(op.writerLeaseId);
    if(!lease||lease.ownerKind!=='ide'||lease.ownerId!==op.operationId||lease.principalId!==op.principalId||lease.projectId!==op.projectId||lease.worktreeId!==op.worktreeId)throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_BINDING','B8 writer binding disagrees with durable operation');
    let proven:'RELEASED'|'UNCERTAIN';
    if(target==='RELEASED'){
      if(lease.state==='RELEASED')proven='RELEASED';
      else if(lease.state==='UNCERTAIN')proven='UNCERTAIN';
      else{
        try{this.opts.writerStore.releaseLiveWriterLease({...binding,reason});proven='RELEASED';}
        catch{
          try{this.opts.writerStore.markLiveWriterUncertain({...binding,reason:'safe writer release could not be proven'});proven='UNCERTAIN';}
          catch{throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_SETTLEMENT_FAILED','writer release/uncertainty could not be proven');}
        }
      }
    }else{
      if(lease.state==='RELEASED')throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_CONFLICT','unsafe operation already has RELEASED writer authority');
      if(lease.state==='UNCERTAIN')proven='UNCERTAIN';
      else{
        try{this.opts.writerStore.markLiveWriterUncertain({...binding,reason});proven='UNCERTAIN';}
        catch{throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_SETTLEMENT_FAILED','writer uncertainty could not be proven');}
      }
    }
    lease=this.opts.writerStore.getLiveWriterLease(op.writerLeaseId);
    if(!lease||lease.state!==proven)throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_WRITER_SETTLEMENT_FAILED','writer settlement reread did not prove final state');
    return proven;
  }

}
