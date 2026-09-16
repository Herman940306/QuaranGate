import { describe, expect, it } from 'vitest';
import { checkReadiness } from '../../src/executor/readiness.js';

describe('SH-02 executor authority readiness', () => {
  it('is ready only when the named Docker-authority broker responds OK', async () => {
    expect(await checkReadiness(async()=>true)).toEqual({ready:true,code:'READY',detail:'Docker authority broker reachable'});
  });
  it('fails closed when broker responds non-OK', async () => {
    const r=await checkReadiness(async()=>false); expect(r.ready).toBe(false); expect(r.code).toBe('DOCKER_AUTHORITY_UNREACHABLE');
  });
  it('fails closed when broker request throws without leaking endpoint/token detail', async () => {
    const r=await checkReadiness(async()=>{throw new Error('secret http://docker-authority:8991')}); expect(r.ready).toBe(false); expect(r.code).toBe('DOCKER_AUTHORITY_UNREACHABLE'); expect(r.detail).not.toMatch(/secret|8991/);
  });
});
