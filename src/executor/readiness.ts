/** SH-02 executor readiness: prove the private Docker-authority broker is reachable. */
import { ping } from './docker.js';
export const READYZ_TIMEOUT_MS = 4_000;
export type ReadinessCode = 'DOCKER_AUTHORITY_UNREACHABLE' | 'DOCKER_AUTHORITY_TIMEOUT' | 'READY';
export interface ReadinessResult { ready:boolean; code:ReadinessCode; detail:string }
export async function checkReadiness(pingFn: () => Promise<boolean> = ping): Promise<ReadinessResult> {
  try {
    const ok=await Promise.race([pingFn(),new Promise<false>((_,reject)=>setTimeout(()=>reject(new Error('timeout')),READYZ_TIMEOUT_MS))]);
    return ok ? {ready:true,code:'READY',detail:'Docker authority broker reachable'} : {ready:false,code:'DOCKER_AUTHORITY_UNREACHABLE',detail:'Docker authority broker returned a non-OK response'};
  } catch(e) {
    const timeout=e instanceof Error&&e.message==='timeout';
    return {ready:false,code:timeout?'DOCKER_AUTHORITY_TIMEOUT':'DOCKER_AUTHORITY_UNREACHABLE',detail:timeout?`Docker authority broker did not respond within ${READYZ_TIMEOUT_MS}ms`:'Docker authority broker request failed'};
  }
}
