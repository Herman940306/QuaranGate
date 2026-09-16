import { describe, expect, it } from 'vitest';
import { validateAuthorityRequest, validateManagedContainerCreate } from '../../src/docker-authority/policy.js';

const labels = { 'io.quarangate.managed': 'true', 'io.quarangate.resource': 'runner', 'io.quarangate.job': 'job-1' };
const safe = { Labels: labels, HostConfig: { Privileged:false, CapAdd:[], CapDrop:['ALL'], SecurityOpt:['no-new-privileges:true'], NetworkMode:'none', Binds:[], Devices:[] } };

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
