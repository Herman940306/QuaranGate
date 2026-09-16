import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
const raw=readFileSync('compose.yaml','utf8'); const cfg:any=YAML.parse(raw);
describe('SH-02 Docker authority containment surface',()=>{
 it('gives the raw Docker socket to exactly one private broker and not executor/gateway',()=>{const consumers=Object.entries(cfg.services).filter(([,v]:any)=>JSON.stringify(v.volumes??[]).includes('/var/run/docker.sock'));expect(consumers.map(([n])=>n)).toEqual(['docker-authority']);expect(JSON.stringify(cfg.services.executor)).not.toContain('/var/run/docker.sock');expect(cfg.services.executor.group_add).toBeUndefined();expect(JSON.stringify(cfg.services.gateway)).not.toContain('/var/run/docker.sock');});
 it('keeps broker unpublished, internal-only, hardened, and without job/data/provider secret mounts',()=>{const b=cfg.services['docker-authority'];expect(b.ports).toBeUndefined();expect(b.networks).toEqual(['internal']);expect(raw).toContain('x-hardening: &hardening');expect(b['<<']).toBeDefined();const j=JSON.stringify(b);expect(j).not.toContain('/jobs');expect(j).not.toContain('/data');expect(b.secrets).toBeUndefined();});
 it('executor reaches only named broker URL and retains its existing private network',()=>{const e=cfg.services.executor;expect(e.environment.DOCKER_AUTHORITY_URL).toBe('http://docker-authority:8991');expect(e.networks).toEqual(['internal']);expect(e.depends_on).toContain('docker-authority');});
});

describe('SH-02 source authority invariants',()=>{
 it('keeps raw daemon transport out of executor source',()=>{for(const f of ['src/executor/docker.ts','src/executor/readiness.ts','src/docker-authority/client.ts'])expect(readFileSync(f,'utf8')).not.toContain('/var/run/docker.sock');});
 it('broker has no generic caller-supplied Docker method/path forwarding contract',()=>{const s=readFileSync('src/docker-authority/server.ts','utf8');expect(s).not.toMatch(/q\.body\.(method|path)|payload\.(method|path)/);expect(s).toContain("validateAuthorityRequest(q.body, trustedHostPaths())");expect(s).toContain('assertManagedContainer');expect(s).toContain('assertManagedVolume');expect(s).toContain('assertManagedNetwork');});
 it('broker derives trusted host bind roots from mounted trusted config, never request payload',()=>{const p=readFileSync('src/docker-authority/policy.ts','utf8');const s=readFileSync('src/docker-authority/server.ts','utf8');expect(p).not.toContain('strings(payload.trustedHostPaths)');expect(s).toContain('trustedHostPaths()');});
});
