import { describe, expect, it } from 'vitest';
import { managedIdentity, validateAuthorityRequest, validateManagedContainerCreate } from '../../src/docker-authority/policy.js';

const labels = { 'io.quarangate.managed': 'true', 'io.quarangate.resource': 'runner', 'io.quarangate.job': `job_${'1'.repeat(32)}` };
const safe = { Image: `sha256:${'a'.repeat(64)}`, Labels: labels, HostConfig: { AutoRemove:false, Privileged:false, ReadonlyRootfs:true, CapAdd:[], CapDrop:['ALL'], SecurityOpt:['no-new-privileges:true'], NetworkMode:'none', Binds:[], Devices:[], Memory:64*1024*1024, PidsLimit:8 } };

describe('SH-02 docker authority policy', () => {
  it('accepts a minimally hardened managed container', () => expect(() => validateManagedContainerCreate(safe)).not.toThrow());
  it.each([
    ['privileged', { ...safe, HostConfig:{...safe.HostConfig, Privileged:true} }],
    ['cap-add', { ...safe, HostConfig:{...safe.HostConfig, CapAdd:['SYS_ADMIN']} }],
    ['host pid', { ...safe, HostConfig:{...safe.HostConfig, PidMode:'host'} }],
    ['device', { ...safe, HostConfig:{...safe.HostConfig, Devices:[{PathOnHost:'/dev/sda'}]} }],
    ['docker socket', { ...safe, HostConfig:{...safe.HostConfig, Binds:['/var/run/docker.sock:/x']} }],
  ])('rejects %s authority', (_name, body) => expect(() => validateManagedContainerCreate(body, ['/workspace'])).toThrow());
  it('rejects unowned resources', () => expect(() => validateManagedContainerCreate({...safe, Labels:{}})).toThrow());
  it('rejects ambiguous legacy/current ownership', () => expect(() => validateManagedContainerCreate({...safe, Labels:{...labels,'io.mcp-bridge.managed':'true','io.mcp-bridge.resource':'runner'}})).toThrow());
  it('rejects generic/raw daemon operations', () => expect(() => validateAuthorityRequest({op:'raw',payload:{method:'DELETE',path:'/containers/x'}})).toThrow());
  it('rejects daemon administration', () => expect(() => validateAuthorityRequest({op:'system.prune',payload:{}})).toThrow());
  it('accepts named operations only', () => expect(validateAuthorityRequest({op:'ping',payload:{}}).op).toBe('ping'));
});

describe('current managed ownership families',()=>{
  it.each(['before-capture','post-capture','git-helper','net','provider-session','secret'])('accepts current general resource %s',(resource)=>{expect(managedIdentity({'io.quarangate.managed':'true','io.quarangate.resource':resource,'io.quarangate.job':'job_x'}).resource).toBe(resource)});
  it('accepts bounded GitHub helper ownership and rejects unknown GitHub resource',()=>{expect(managedIdentity({'io.quarangate.github.managed':'true','io.quarangate.github.resource':'push-helper','io.quarangate.github.operation':'gh_0123456789abcdef01234567'}).resource).toBe('push-helper');expect(()=>managedIdentity({'io.quarangate.github.managed':'true','io.quarangate.github.resource':'evil','io.quarangate.github.operation':'gh_0123456789abcdef01234567'})).toThrow();expect(()=>managedIdentity({'io.quarangate.github.managed':'true','io.quarangate.github.resource':'push-helper','io.quarangate.github.operation':'gh_0123456789abcdef01234567','io.quarangate.managed':'false'})).toThrow();});
});
