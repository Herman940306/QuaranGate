import { describe, expect, it } from 'vitest';
import {
  managedIdentity,
  validateManagedContainerCreate,
  validateManagedExecCreate,
  validateManagedNetworkAttachment,
  validateManagedNetworkCreate,
  validateManagedVolumeAttachment,
  validateManagedVolumeCreate,
  type ManagedVolumeMount,
} from '../../src/docker-authority/policy.js';
import { buildApplierCreateBody, toRunnerLimits } from '../../src/executor/agents/sandboxSpec.js';
import { buildRunnerCreateBody, PROVIDER_BINDING_LABEL } from '../../src/executor/agents/kiroBackend.js';

const JOB_A = `job_${'a'.repeat(32)}`;
const JOB_B = `job_${'b'.repeat(32)}`;
const ATTEMPT = `att_${'c'.repeat(32)}`;
const IMAGE = `sha256:${'d'.repeat(64)}`;
const BINDING = 'e'.repeat(64);
const labels = (resource: string, job = JOB_A, extra: Record<string,string> = {}) => ({
  'io.quarangate.managed': 'true', 'io.quarangate.resource': resource, 'io.quarangate.job': job, ...extra,
});
const safeBody = () => ({
  Image: IMAGE,
  User: '1000:1000',
  Labels: labels('runner'),
  HostConfig: {
    AutoRemove: false, Privileged: false, ReadonlyRootfs: true,
    CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'], GroupAdd: [], Devices: [],
    PidMode: '', IpcMode: 'private', UTSMode: '', UsernsMode: '', NetworkMode: 'none',
    Memory: 64 * 1024 * 1024, MemorySwap: 64 * 1024 * 1024, NanoCpus: 500_000_000, PidsLimit: 16,
    Mounts: [],
  },
});

function expectDenied(mutator: (body: any) => void): void {
  const body: any = safeBody(); mutator(body);
  expect(() => validateManagedContainerCreate(body, ['/workspace/project'])).toThrow();
}

describe('SH-11 hostile Docker create policy', () => {
  it.each([
    ['privileged', (b:any)=>{ b.HostConfig.Privileged=true; }],
    ['host PID', (b:any)=>{ b.HostConfig.PidMode='host'; }],
    ['host IPC', (b:any)=>{ b.HostConfig.IpcMode='host'; }],
    ['host UTS', (b:any)=>{ b.HostConfig.UTSMode='host'; }],
    ['custom userns', (b:any)=>{ b.HostConfig.UsernsMode='host'; }],
    ['device', (b:any)=>{ b.HostConfig.Devices=[{PathOnHost:'/dev/kvm'}]; }],
    ['device request', (b:any)=>{ b.HostConfig.DeviceRequests=[{Capabilities:[['gpu']]}]; }],
    ['supplementary group', (b:any)=>{ b.HostConfig.GroupAdd=['docker']; }],
    ['volumes-from', (b:any)=>{ b.HostConfig.VolumesFrom=['victim']; }],
    ['host port', (b:any)=>{ b.HostConfig.PortBindings={'22/tcp':[{'HostPort':'2222'}]}; }],
    ['publish all', (b:any)=>{ b.HostConfig.PublishAllPorts=true; }],
    ['custom DNS', (b:any)=>{ b.HostConfig.Dns=['127.0.0.1']; }],
    ['extra host', (b:any)=>{ b.HostConfig.ExtraHosts=['host.docker.internal:host-gateway']; }],
    ['custom runtime', (b:any)=>{ b.HostConfig.Runtime='runc-evil'; }],
    ['cgroup parent', (b:any)=>{ b.HostConfig.CgroupParent='/'; }],
    ['unconfined seccomp', (b:any)=>{ b.HostConfig.SecurityOpt=['no-new-privileges','seccomp=unconfined']; }],
    ['writable root', (b:any)=>{ b.HostConfig.ReadonlyRootfs=false; }],
    ['unbounded memory', (b:any)=>{ delete b.HostConfig.Memory; }],
    ['unbounded pids', (b:any)=>{ delete b.HostConfig.PidsLimit; }],
    ['mutable image ref', (b:any)=>{ b.Image='helper:1.2.3'; }],
    ['structured host bind', (b:any)=>{ b.HostConfig.Mounts=[{Type:'bind',Source:'/workspace/project',Target:'/x',ReadOnly:true}]; }],
    ['anonymous volume', (b:any)=>{ b.Volumes={'/escape':{}}; }],
    ['masked path override', (b:any)=>{ b.HostConfig.MaskedPaths=[]; }],
    ['readonly path override', (b:any)=>{ b.HostConfig.ReadonlyPaths=[]; }],
    ['custom sysctl', (b:any)=>{ b.HostConfig.Sysctls={'net.ipv4.ip_forward':'1'}; }],
    ['oversized tmpfs', (b:any)=>{ b.HostConfig.Tmpfs={'/tmp':'rw,nosuid,nodev,size=1g'}; }],
    ['non-array binds', (b:any)=>{ b.HostConfig.Binds='/workspace/project:/src:ro'; }],
    ['non-array capadd', (b:any)=>{ b.HostConfig.CapAdd='SYS_ADMIN'; }],
  ])('rejects %s', (_name, mutate) => expectDenied(mutate));

  it('allows only the applier narrow capability exception and exact trusted RW project bind', () => {
    const limits = toRunnerLimits({ maxMemoryBytes: 256*1024*1024, maxCpuMillicores: 500, maxPids: 32, maxRuntimeMs: 60000, maxOutputBytes: 65536, maxEvidenceBytes: 1024*1024 } as any);
    const body = buildApplierCreateBody({ image: IMAGE, jobId: JOB_A, attemptId: ATTEMPT, hostPath:'/workspace/project', artifactVolume:'ev', controlVolume:'ctl', limits });
    expect(() => validateManagedContainerCreate(body, ['/workspace/project'])).not.toThrow();
    const bad:any = structuredClone(body); bad.HostConfig.CapAdd=['SYS_ADMIN'];
    expect(() => validateManagedContainerCreate(bad, ['/workspace/project'])).toThrow();
  });

  it('requires exact trusted bind roots rather than trusted-root descendants', () => {
    const body:any = safeBody();
    body.Labels=labels('git-helper'); body.HostConfig.Binds=['/workspace/project/sub:/src:ro'];
    expect(() => validateManagedContainerCreate(body, ['/workspace/project'])).toThrow();
  });
});

describe('SH-11 managed volume authority', () => {
  const mount = (Source:string, Target:string, ReadOnly:boolean): ManagedVolumeMount => ({Type:'volume',Source,Target,ReadOnly});
  it('denies cross-job secret/evidence attachment even with a valid managed token', () => {
    const runner=managedIdentity(labels('runner',JOB_A));
    const secret=managedIdentity(labels('secret',JOB_B));
    const evidence=managedIdentity(labels('evidence',JOB_B));
    expect(() => validateManagedVolumeAttachment(runner,secret,mount('s','/run/secrets',true))).toThrow();
    expect(() => validateManagedVolumeAttachment(runner,evidence,mount('e','/workspace',false))).toThrow();
  });

  it('allows provider-session cross-job reuse only through the same trusted provider binding', () => {
    const runner=managedIdentity(labels('runner',JOB_B,{[PROVIDER_BINDING_LABEL]:BINDING}));
    const session=managedIdentity(labels('provider-session',JOB_A,{[PROVIDER_BINDING_LABEL]:BINDING}));
    expect(() => validateManagedVolumeAttachment(runner,session,mount('ps','/home/runner/.kiro/sessions/cli',false))).not.toThrow();
    const wrong=managedIdentity(labels('provider-session',JOB_A,{[PROVIDER_BINDING_LABEL]:'f'.repeat(64)}));
    expect(() => validateManagedVolumeAttachment(runner,wrong,mount('ps','/home/runner/.kiro/sessions/cli',false))).toThrow();
  });

  it('restricts new volume resource kinds and provider-session binding', () => {
    expect(() => validateManagedVolumeCreate('v',labels('workspace'))).not.toThrow();
    expect(() => validateManagedVolumeCreate('v',labels('runner'))).toThrow();
    expect(() => validateManagedVolumeCreate('v',labels('provider-session'))).toThrow();
    expect(() => validateManagedVolumeCreate('v',labels('provider-session',JOB_A,{[PROVIDER_BINDING_LABEL]:BINDING}))).not.toThrow();
  });
});

describe('SH-11 managed network authority', () => {
  it('requires deterministic job network names and internal/external policy', () => {
    const netLabels=labels('net');
    expect(() => validateManagedNetworkCreate(`io-quarangate-net-${JOB_A}`,true,netLabels)).not.toThrow();
    expect(() => validateManagedNetworkCreate(`io-quarangate-net-${JOB_A}-ext`,false,netLabels)).not.toThrow();
    expect(() => validateManagedNetworkCreate('attacker-net',false,netLabels)).toThrow();
  });
  it('denies cross-job network attachment and non-proxy second-network attachment', () => {
    const net=managedIdentity(labels('net',JOB_A));
    const proxy=managedIdentity(labels('proxy',JOB_A));
    expect(() => validateManagedNetworkAttachment(net,proxy)).not.toThrow();
    expect(() => validateManagedNetworkAttachment(net,managedIdentity(labels('proxy',JOB_B)))).toThrow();
    expect(() => validateManagedNetworkAttachment(net,managedIdentity(labels('runner',JOB_A)))).toThrow();
  });
});

describe('SH-11 Kiro session binding propagation', () => {
  it('places the trusted provider binding on the runner identity used by broker volume admission', () => {
    const body:any=buildRunnerCreateBody({
      jobId:JOB_B,image:IMAGE,workspaceVolume:'ws',secretVolume:'sec',homeVolume:'home',controlVolume:'ctl',providerSessionVolume:'ps',providerBinding:BINDING,
      internalNetwork:`io-quarangate-net-${JOB_B}`,proxyUrl:'http://egress-proxy:8080',memoryBytes:256*1024*1024,nanoCpus:500_000_000,pidsLimit:32,workspaceReadOnly:true,
    });
    expect(body.Labels[PROVIDER_BINDING_LABEL]).toBe(BINDING);
    expect(managedIdentity(body.Labels).providerBinding).toBe(BINDING);
  });
});


describe('SH-11 Docker exec authority', () => {
  const safeExec = { AttachStdout:true, AttachStderr:true, Tty:false, Cmd:['/bin/sh','-c','printf ok'], WorkingDir:'/workspace', Env:['A=B'], User:'1000:1000' };
  it('accepts only the bounded executor wrapper shape', () => expect(() => validateManagedExecCreate(safeExec)).not.toThrow());
  it.each([
    ['privileged exec', { ...safeExec, Privileged:true }],
    ['stdin attachment', { ...safeExec, AttachStdin:true }],
    ['tty', { ...safeExec, Tty:true }],
    ['relative working dir', { ...safeExec, WorkingDir:'workspace' }],
    ['unknown field', { ...safeExec, DetachKeys:'ctrl-x' }],
    ['oversized env', { ...safeExec, Env:Array.from({length:257},(_,i)=>`K${i}=x`) }],
    ['empty command', { ...safeExec, Cmd:[] }],
  ])('rejects %s', (_name, body) => expect(() => validateManagedExecCreate(body)).toThrow());
});

describe('SH-11 production builder parity', () => {
  it('accepts the core sandbox builders under broker policy', async () => {
    const mod = await import('../../src/executor/agents/sandboxSpec.js');
    const limits = mod.toRunnerLimits({ maxMemoryBytes:256*1024*1024, maxCpuMillicores:500, maxPids:32, maxRuntimeMs:60000, maxOutputBytes:65536, maxEvidenceBytes:1024*1024 } as any);
    const bodies = [
      mod.buildStagerCreateBody({ image:IMAGE, jobId:JOB_A, hostPath:'/workspace/project', volumeName:'ws' }),
      mod.buildRunnerCreateBody({ image:IMAGE, jobId:JOB_A, volumeName:'ws', limits, networkMode:'none', readRelPath:'README.md' }),
      mod.buildManifestCreateBody({ image:IMAGE, jobId:JOB_A, volumeName:'ws', limits }),
      mod.buildOllamaReadHelperCreateBody({ image:IMAGE, jobId:JOB_A, workspaceVolumeName:'ws', limits }),
      mod.buildApplierCreateBody({ image:IMAGE, jobId:JOB_A, attemptId:ATTEMPT, hostPath:'/workspace/project', artifactVolume:'ev', controlVolume:'ctl', limits }),
    ];
    for (const body of bodies) expect(() => validateManagedContainerCreate(body, ['/workspace/project'])).not.toThrow();
  });

  it('accepts Git helper and evidence reader trusted specs', async () => {
    const { buildGitHelperSpec } = await import('../../src/executor/agents/gitHelper.js');
    const { buildEvidenceReaderSpec } = await import('../../src/executor/agents/artifactReader.js');
    const git = buildGitHelperSpec({ helperImage:IMAGE, jobId:JOB_A, hostPath:'/workspace/project' } as any);
    const evidence = buildEvidenceReaderSpec('ev', IMAGE, JOB_A);
    expect(() => validateManagedContainerCreate(git as any, ['/workspace/project'])).not.toThrow();
    expect(() => validateManagedContainerCreate(evidence as any, ['/workspace/project'])).not.toThrow();
  });

  it('accepts Kiro and Copilot runner specs with their exact governed networks', async () => {
    const { buildCopilotRunnerCreateBody } = await import('../../src/executor/agents/copilotBackend.js');
    const kiro = buildRunnerCreateBody({
      jobId:JOB_A,image:IMAGE,workspaceVolume:'ws',secretVolume:'sec',homeVolume:'home',controlVolume:'ctl',providerSessionVolume:'ps',providerBinding:BINDING,
      internalNetwork:`io-quarangate-net-${JOB_A}`,proxyUrl:'http://egress-proxy:8080',memoryBytes:256*1024*1024,nanoCpus:500_000_000,pidsLimit:32,workspaceReadOnly:true,
    });
    const copilot = buildCopilotRunnerCreateBody({
      jobId:JOB_A,image:IMAGE,workspaceVolume:'ws',secretVolume:'sec',homeVolume:'home',controlVolume:'ctl',
      internalNetwork:`io-quarangate-net-${JOB_A}-copilot-int`,proxyUrl:'http://egress-proxy:8080',memoryBytes:256*1024*1024,nanoCpus:500_000_000,pidsLimit:32,
    });
    expect(() => validateManagedContainerCreate(kiro, ['/workspace/project'])).not.toThrow();
    expect(() => validateManagedContainerCreate(copilot, ['/workspace/project'])).not.toThrow();
  });

  it('accepts GitHub head/push helpers while retaining exact host/network bounds', async () => {
    const { buildGitHubHeadCheckSpec, buildGitHubPushHelperSpec } = await import('../../src/executor/githubControl.js');
    const op=`gh_${'1'.repeat(24)}`;
    const head=buildGitHubHeadCheckSpec({image:IMAGE,hostPath:'/workspace/project',operationId:op});
    const push=buildGitHubPushHelperSpec({image:IMAGE,hostPath:'/workspace/project',secretVolume:'gh-secret',controlNetwork:'quarangate-github-control',operationId:op,owner:'Owner',repo:'repo',expectedHead:'a'.repeat(40),remoteBranch:'feature'});
    expect(() => validateManagedContainerCreate(head, ['/workspace/project'])).not.toThrow();
    expect(() => validateManagedContainerCreate(push, ['/workspace/project'])).not.toThrow();
  });
});
