import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deriveIdeEnvironmentIdentity,
  deriveIdeFilesystemIdentity,
  deriveIdeWorkspaceFingerprint,
  serializeIdeWorkspaceAttestation,
  type IdeWorkspaceAttestation,
  type IdeWorkspacePhysicalIdentity,
} from '../../src/shared/ideWorkspaceAttestation.js';
import type { AdmittedIdeCompanionRequest } from '../../src/executor/ide/ideCompanionAdmission.js';
import { createIdeCompanionRuntime, type IdeCompanionRuntimeRef } from '../../src/executor/ide/ideCompanionRuntime.js';
import { IdeSessionStore } from '../../src/executor/ide/ideSessionStore.js';
import { IdeWorkspaceVerificationError, verifyAuthenticatedIdeWorkspace } from '../../src/executor/ide/ideWorkspaceAttestation.js';

let store: IdeSessionStore;
let runtimeRoot: string;
let fixtureSequence = 0;
const baseRevision = 'a'.repeat(40);

function physical(over: Partial<IdeWorkspacePhysicalIdentity> = {}): IdeWorkspacePhysicalIdentity {
  const path = '/srv/projects/quarangate-forward';
  return {
    workspaceFolderCount: 1,
    remoteKind: 'wsl',
    environmentIdentity: deriveIdeEnvironmentIdentity('wsl', 'ubuntu-24.04:stable-id'),
    pathFlavor: 'posix',
    caseMode: 'case-sensitive',
    canonicalization: 'realpath-exact',
    workspaceUri: pathToFileURL(path).href,
    canonicalPath: path,
    filesystemIdentity: deriveIdeFilesystemIdentity('posix', '100', '200'),
    git: {
      kind: 'worktree', worktreeRoot: path, commonDir: '/srv/projects/QuaranGate/.git',
      commonDirIdentity: deriveIdeFilesystemIdentity('posix', '100', '300'), headRevision: baseRevision,
    },
    ...over,
  };
}

function setup(over: { workspace?: IdeWorkspacePhysicalIdentity; baseRevision?: string | undefined } = {}) {
  fixtureSequence += 1;
  const digit = (fixtureSequence % 15 + 1).toString(16);
  const sessionDigit = ((fixtureSequence + 7) % 15 + 1).toString(16);
  const w = over.workspace ?? physical();
  const fingerprint = deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace: w });
  const e = store.createEnrollment({
    principalId: 'chatgpt-browser', projectId: 'quarangate', worktreeId: 'forward', ideProduct: 'vscode',
    ideInstanceId: `ide_${digit.repeat(32)}`, workspaceFingerprint: fingerprint,
    ...(over.baseRevision !== undefined ? { baseRevision: over.baseRevision } : { baseRevision }),
    capabilities: ['prompt', 'cancel', 'observe_response', 'request_review'],
  });
  const s = store.openSession({
    enrollmentId: e.enrollmentId, principalId: e.principalId, projectId: e.projectId, worktreeId: e.worktreeId,
    ideProduct: e.ideProduct, ideInstanceId: e.ideInstanceId, workspaceFingerprint: e.workspaceFingerprint,
    baseRevision: e.baseRevision, sessionId: `ides_${sessionDigit.repeat(32)}`,
  });
  const key = {
    principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,ideProduct:e.ideProduct,
    ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,baseRevision:e.baseRevision,
    sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,
  } as const;
  store.markAvailable(key);
  const runtime = createIdeCompanionRuntime({ runtimeRoot, enrollmentId:e.enrollmentId, ideInstanceId:e.ideInstanceId, ideProduct:e.ideProduct, adapterVersion:'1.2.3' });
  const a: IdeWorkspaceAttestation = {
    version:1,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,runtimeInstanceId:runtime.runtimeInstanceId,
    ideProduct:e.ideProduct,adapterId:runtime.adapterId,adapterVersion:runtime.adapterVersion,
    sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,workspace:w,
  };
  return { e, s, key, runtime, a, w };
}

function payload(a: IdeWorkspaceAttestation): string { return serializeIdeWorkspaceAttestation(a); }
function admitted(a: IdeWorkspaceAttestation, bytes = payload(a)): AdmittedIdeCompanionRequest {
  return {
    enrollmentId:a.enrollmentId,ideInstanceId:a.ideInstanceId,sessionId:a.sessionId,
    connectionGeneration:a.connectionGeneration,controllerLeaseId:`idectl_${'3'.repeat(32)}`,
    operationId:`ideo_${'4'.repeat(32)}`,capability:'request_review',
    payloadSha256:createHash('sha256').update(bytes,'utf8').digest('hex'),
  };
}
function code(fn:()=>unknown):string {
  try { fn(); return 'NO_ERROR'; } catch(error) { return error instanceof IdeWorkspaceVerificationError ? error.code : 'OTHER_ERROR'; }
}

beforeEach(() => {
  store = new IdeSessionStore(join(mkdtempSync(join(tmpdir(),'qg-ide-ws-db-')),'ide.db'));
  const base=mkdtempSync(join(tmpdir(),'qg-ide-ws-runtime-')); chmodSync(base,0o700);
  runtimeRoot=join(base,'runtime'); mkdirSync(runtimeRoot,{mode:0o700}); chmodSync(runtimeRoot,0o700);
  fixtureSequence = 0;
});

describe('P7 B5 trusted workspace verifier', () => {
  it('accepts authenticated exact evidence and returns authority only from trusted enrollment', () => {
    const ctx=setup(); const bytes=payload(ctx.a);
    const verified=verifyAuthenticatedIdeWorkspace({store,runtime:ctx.runtime,admitted:admitted(ctx.a,bytes),payload:bytes});
    expect(verified).toMatchObject({
      enrollmentId:ctx.e.enrollmentId,principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward',
      workspaceFingerprint:ctx.e.workspaceFingerprint,baseRevision,ideProduct:'vscode',ideInstanceId:ctx.e.ideInstanceId,
      runtimeInstanceId:ctx.runtime.runtimeInstanceId,sessionId:ctx.s.sessionId,connectionGeneration:1,
      filesystemIdentity:ctx.w.filesystemIdentity,environmentIdentity:ctx.w.environmentIdentity,gitHeadRevision:baseRevision,
    });
    expect(Object.keys(ctx.a)).not.toContain('projectId');
    expect(Object.keys(ctx.a)).not.toContain('worktreeId');
    expect(Object.keys(ctx.a)).not.toContain('workspaceFingerprint');
  });

  it('rejects payload bytes that do not match the authenticated B3 payload hash before trusting evidence', () => {
    const ctx=setup(); const bytes=payload(ctx.a); const auth=admitted(ctx.a,bytes);
    const changed=payload({...ctx.a,adapterVersion:'1.2.4'});
    expect(code(()=>verifyAuthenticatedIdeWorkspace({store,runtime:ctx.runtime,admitted:auth,payload:changed}))).toBe('IDE_WORKSPACE_PAYLOAD_NOT_AUTHENTICATED');
  });

  it('rejects attestation identity drift from authenticated admission even when attacker supplies a matching payload hash', () => {
    const ctx=setup();
    const changed={...ctx.a,sessionId:`ides_${'f'.repeat(32)}`}; const bytes=payload(changed);
    expect(code(()=>verifyAuthenticatedIdeWorkspace({store,runtime:ctx.runtime,admitted:admitted(ctx.a,bytes),payload:bytes}))).toBe('IDE_WORKSPACE_PAYLOAD_NOT_AUTHENTICATED');
  });

  it('rejects runtime instance/product/adapter/version substitution', () => {
    const changes: Array<Partial<IdeWorkspaceAttestation>>=[
      {runtimeInstanceId:`iderun_${'9'.repeat(32)}`},{ideProduct:'cursor'},
      {adapterId:'quarangate-cursor-companion'},{adapterVersion:'1.2.4'},
    ];
    for(const change of changes){const ctx=setup();const a={...ctx.a,...change} as IdeWorkspaceAttestation;const bytes=payload(a);
      const auth={...admitted(a,bytes),enrollmentId:ctx.e.enrollmentId,ideInstanceId:ctx.e.ideInstanceId,sessionId:ctx.s.sessionId,connectionGeneration:ctx.s.connectionGeneration};
      expect(code(()=>verifyAuthenticatedIdeWorkspace({store,runtime:ctx.runtime,admitted:auth,payload:bytes}))).toBe('IDE_WORKSPACE_RUNTIME_MISMATCH');}
  });

  it('rejects physical workspace/environment/Git-common identity substitution despite valid authenticated bytes', () => {
    const mutations: Array<(w:IdeWorkspacePhysicalIdentity)=>IdeWorkspacePhysicalIdentity>=[
      w=>({...w,filesystemIdentity:'f'.repeat(64)}),
      w=>({...w,environmentIdentity:'e'.repeat(64)}),
      w=>w.git.kind==='worktree'?({...w,git:{...w.git,commonDirIdentity:'d'.repeat(64)}}):w,
    ];
    for(const mutate of mutations){const ctx=setup();const a={...ctx.a,workspace:mutate(ctx.w)};const bytes=payload(a);
      expect(code(()=>verifyAuthenticatedIdeWorkspace({store,runtime:ctx.runtime,admitted:admitted(a,bytes),payload:bytes}))).toBe('IDE_WORKSPACE_FINGERPRINT_MISMATCH');}
  });

  it('checks pinned baseRevision separately from stable workspace fingerprint', () => {
    const ctx=setup(); if(ctx.w.git.kind!=='worktree') throw new Error('fixture');
    const changed={...ctx.a,workspace:{...ctx.w,git:{...ctx.w.git,headRevision:'b'.repeat(40)}}};
    expect(deriveIdeWorkspaceFingerprint({projectId:'quarangate',worktreeId:'forward',workspace:changed.workspace})).toBe(ctx.e.workspaceFingerprint);
    const bytes=payload(changed);
    expect(code(()=>verifyAuthenticatedIdeWorkspace({store,runtime:ctx.runtime,admitted:admitted(changed,bytes),payload:bytes}))).toBe('IDE_WORKSPACE_BASE_REVISION_MISMATCH');
  });

  it('requires Git worktree evidence when enrollment pins a base revision', () => {
    const noGit=physical({git:{kind:'none'}}); const ctx=setup({workspace:noGit}); const bytes=payload(ctx.a);
    expect(code(()=>verifyAuthenticatedIdeWorkspace({store,runtime:ctx.runtime,admitted:admitted(ctx.a,bytes),payload:bytes}))).toBe('IDE_WORKSPACE_BASE_REVISION_MISMATCH');
  });

  it('permits non-Git evidence only when enrollment does not pin a base revision', () => {
    const noGit=physical({git:{kind:'none'}});
    const fingerprint=deriveIdeWorkspaceFingerprint({projectId:'quarangate',worktreeId:'forward',workspace:noGit});
    const e=store.createEnrollment({principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward',ideProduct:'vscode',ideInstanceId:`ide_${'7'.repeat(32)}`,workspaceFingerprint:fingerprint,capabilities:['request_review']});
    const s=store.openSession({enrollmentId:e.enrollmentId,principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,ideProduct:e.ideProduct,ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,sessionId:`ides_${'8'.repeat(32)}`});
    const k={principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,ideProduct:e.ideProduct,ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration} as const;store.markAvailable(k);
    const runtime=createIdeCompanionRuntime({runtimeRoot,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,ideProduct:e.ideProduct,adapterVersion:'1.2.3'});
    const a:IdeWorkspaceAttestation={version:1,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,runtimeInstanceId:runtime.runtimeInstanceId,ideProduct:e.ideProduct,adapterId:runtime.adapterId,adapterVersion:runtime.adapterVersion,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,workspace:noGit};
    const bytes=payload(a);expect(()=>verifyAuthenticatedIdeWorkspace({store,runtime,admitted:admitted(a,bytes),payload:bytes})).not.toThrow();
  });

  it('invalidates old attestation after reconnect generation advances', () => {
    const ctx=setup(); const oldBytes=payload(ctx.a); const oldAuth=admitted(ctx.a,oldBytes);
    const current=store.getEnrollment(ctx.e.enrollmentId)!;
    store.openSession({enrollmentId:current.enrollmentId,principalId:current.principalId,projectId:current.projectId,worktreeId:current.worktreeId,ideProduct:current.ideProduct,ideInstanceId:current.ideInstanceId,workspaceFingerprint:current.workspaceFingerprint,baseRevision:current.baseRevision,sessionId:`ides_${'f'.repeat(32)}`});
    expect(code(()=>verifyAuthenticatedIdeWorkspace({store,runtime:ctx.runtime,admitted:oldAuth,payload:oldBytes}))).toBe('IDE_WORKSPACE_SESSION_MISMATCH');
  });

  it('rejects revoked enrollment and terminal session evidence', () => {
    const a=setup(); const bytes=payload(a.a); store.revokeEnrollment({enrollmentId:a.e.enrollmentId,principalId:a.e.principalId,projectId:a.e.projectId,worktreeId:a.e.worktreeId,ideProduct:a.e.ideProduct,ideInstanceId:a.e.ideInstanceId,workspaceFingerprint:a.e.workspaceFingerprint,baseRevision:a.e.baseRevision});
    expect(code(()=>verifyAuthenticatedIdeWorkspace({store,runtime:a.runtime,admitted:admitted(a.a,bytes),payload:bytes}))).toBe('IDE_WORKSPACE_ENROLLMENT_DENIED');

    const b=setup({workspace:{...physical(),filesystemIdentity:'9'.repeat(64)}}); const bbytes=payload(b.a); store.disconnect(b.key);
    expect(code(()=>verifyAuthenticatedIdeWorkspace({store,runtime:b.runtime,admitted:admitted(b.a,bbytes),payload:bbytes}))).toBe('IDE_WORKSPACE_SESSION_MISMATCH');
  });

  it('rejects a forged B4 runtime reference before workspace comparison', () => {
    const ctx=setup(); const bytes=payload(ctx.a);
    const forged={...ctx.runtime,credentialPath:join(runtimeRoot,'elsewhere.json')} as IdeCompanionRuntimeRef;
    expect(()=>verifyAuthenticatedIdeWorkspace({store,runtime:forged,admitted:admitted(ctx.a,bytes),payload:bytes})).toThrow();
  });
});
