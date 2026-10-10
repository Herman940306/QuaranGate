import express from 'express';
import { Pool } from 'undici';
import fs from 'node:fs';
import YAML from 'yaml';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import { exactAssessmentInventoryResource, managedIdentity, managedVolumeMounts, validateAuthorityRequest, validateManagedArchivePath, validateManagedExecForIdentity, validateManagedNetworkAttachment, validateManagedVolumeAttachment } from './policy.js';

const TOKEN = process.env.DOCKER_AUTHORITY_TOKEN ?? '';
const SOCK = process.env.DOCKER_SOCK ?? '/var/run/docker.sock';
const PORT = Number(process.env.DOCKER_AUTHORITY_PORT ?? 8991);
const docker = new Pool('http://localhost', { socketPath: SOCK, connections: 16 });
const API='/v1.44';
// 128 BE9 resources at up to 16 KiB of Docker list/inspect metadata each.
const BE9_INVENTORY_MAX_BYTES=2*1024*1024;
const BE9_INVENTORY_MAX_ROWS=128;
function enc(v:unknown){return encodeURIComponent(String(v));}
function rec(v:unknown):Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v)) throw new BridgeError('FORBIDDEN_POLICY','invalid authority payload',403);return v as Record<string,any>}
/** Serialize competing create/remove operations on the same managed volume name.
 * This protects the trusted broker's inspect-then-delete sequence against a
 * concurrent request to the same broker, without adding Docker privileges.
 * Out-of-band raw Docker socket actors remain outside this guarantee.
 */
const volumeMutationLocks = new Map<string, Promise<void>>();
async function serializedVolumeMutation<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const previous = volumeMutationLocks.get(name);
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => { unlock = resolve; });
  volumeMutationLocks.set(name, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    unlock();
    if (volumeMutationLocks.get(name) === current) volumeMutationLocks.delete(name);
  }
}
async function req(method:string,path:string,body?:unknown){const r=await docker.request({method:method as any,path,headers:body===undefined?undefined:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const b=Buffer.from(await r.body.arrayBuffer());if(r.statusCode>=400&&r.statusCode!==404)throw new BridgeError('DOCKER_UNAVAILABLE',`docker operation failed: ${r.statusCode} ${b.toString('utf8').slice(0,160)}`,502);return {status:r.statusCode,body:b,headers:r.headers}}
async function boundedInventoryJson(path:string):Promise<any>{
  const r=await docker.request({method:'GET',path});
  const body=r.body;
  const fail=()=>new BridgeError('DOCKER_UNAVAILABLE','assessment inventory could not be proven complete',502);
  try {
    const length=r.headers['content-length'];
    if(r.statusCode>=400 || (length!==undefined && (typeof length!=='string' || !/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length)>BigInt(BE9_INVENTORY_MAX_BYTES)))) throw fail();
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>BE9_INVENTORY_MAX_BYTES)throw fail();chunks.push(bytes);}
    return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
  }catch{body.destroy();throw fail();}
}
function filters(v:unknown){const r=rec(v??{});for(const [k,a] of Object.entries(r))if(!Array.isArray(a)||!(a as unknown[]).every(x=>typeof x==='string')||!['label','name'].includes(k))throw new BridgeError('FORBIDDEN_POLICY','unsupported Docker filter',403);return encodeURIComponent(JSON.stringify(r));}
function exactInventoryLabels(labels:unknown, wanted:Record<string,string>,resource:string){
  const identity=managedIdentity(labels);
  const l=rec(labels);
  if(identity.scope!=='sandbox'||identity.namespace!=='io.quarangate'||identity.resource!==resource
    || Object.entries(wanted).some(([key,value])=>l[key]!==value))
    throw new BridgeError('FORBIDDEN_POLICY','assessment inventory ownership is not exact',403);
}
function inventoryFailure(error:unknown):BridgeError{
  return error instanceof BridgeError && error.code==='FORBIDDEN_POLICY'
    ? new BridgeError('FORBIDDEN_POLICY','assessment inventory ownership is not exact',403)
    : new BridgeError('DOCKER_UNAVAILABLE','assessment inventory could not be proven complete',502);
}
function trustedTarget(info:any):boolean{const l=info?.Config?.Labels??{};if(l['io.quarangate.managed']==='true'||l['io.mcp-ide-bridge.managed']==='true'||l['io.mcp-bridge.managed']==='true'){managedIdentity(l);return true;}if(l['mcp.bridge.enabled']==='true'&&typeof l['mcp.bridge.workspace']==='string'&&l['mcp.bridge.workspace'].startsWith('/'))return true;let cfg:any={};try{cfg=YAML.parse(fs.readFileSync(process.env.BRIDGE_CONFIG??'/config/bridge.yaml','utf8'))??{}}catch{};const names=(info?.Name?[info.Name]:info?.Names??[]).map((x:string)=>x.replace(/^\//,''));return (cfg.targets??[]).some((t:any)=>t.containerName?names.includes(t.containerName):(l['com.docker.compose.project']===t.composeProject&&l['com.docker.compose.service']===t.composeService));}
async function assertContainer(id:string, exactInventory=false){let j:any;
  if(exactInventory)j=await boundedInventoryJson(`${API}/containers/${enc(id)}/json`);
  else{const r=await req('GET',`${API}/containers/${enc(id)}/json`);if(r.status===404)throw new BridgeError('UNKNOWN_TARGET','container is not available',404);j=JSON.parse(r.body.toString());}
  if(!trustedTarget(j))throw new BridgeError('FORBIDDEN_POLICY','container is outside QuaranGate authority',403);return j;}
async function assertManagedContainer(id:string){const j=await assertContainer(id);const identity=managedIdentity(j.Config?.Labels);return { info:j, identity };}
function managedIdentityFromTrustedContainer(info:any){const l=info?.Config?.Labels??{};const marked=l['io.quarangate.managed']!==undefined||l['io.mcp-ide-bridge.managed']!==undefined||l['io.mcp-bridge.managed']!==undefined||l['io.quarangate.github.managed']!==undefined;return marked?managedIdentity(l):null;}
async function managedVolume(name:string){const r=await req('GET',`${API}/volumes/${enc(name)}`);if(r.status===404)throw new BridgeError('FORBIDDEN_POLICY','managed volume is not available',403);const info=JSON.parse(r.body.toString());return {info,identity:managedIdentity(info.Labels)};}
async function assertManagedVolume(name:string){const r=await req('GET',`${API}/volumes/${enc(name)}`);if(r.status===404)return null;const info=JSON.parse(r.body.toString());managedIdentity(info.Labels);return info;}
async function managedNetwork(id:string){const r=await req('GET',`${API}/networks/${enc(id)}`);if(r.status===404)throw new BridgeError('FORBIDDEN_POLICY','managed network is not available',403);const info=JSON.parse(r.body.toString());return {info,identity:managedIdentity(info.Labels)};}
async function assertManagedNetwork(id:string){const r=await req('GET',`${API}/networks/${enc(id)}`);if(r.status===404)return null;const info=JSON.parse(r.body.toString());managedIdentity(info.Labels);return info;}
async function json(method:string,path:string,body?:unknown){const r=await req(method,path,body);return r.body.length?JSON.parse(r.body.toString()):null}

function trustedHostPaths(): string[] { const out:string[]=[]; for(const file of [process.env.AGENTS_CONFIG??'/config/agents.yaml',process.env.GITHUB_CONFIG??'/config/github.yaml']) { try { const v:any=YAML.parse(fs.readFileSync(file,'utf8'))??{}; const walk=(x:any)=>{if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object')for(const [k,val] of Object.entries(x)){if((k==='hostPath'||k==='host_path')&&typeof val==='string'&&val.startsWith('/'))out.push(val);else walk(val)}}; walk(v); } catch {} } return [...new Set(out)]; }
const app=express();app.use(express.json({limit:'16mb'}));app.use((q,s,n)=>{if(!TOKEN||q.header('x-internal-token')!==TOKEN){s.status(401).json({error:'UNAUTHENTICATED'});return;}n()});
app.get('/healthz',(_q,s)=>s.json({ok:true}));app.get('/readyz',async(_q,s)=>{try{const r=await req('GET','/_ping');s.status(r.status===200?200:503).json({ok:r.status===200})}catch{s.status(503).json({ok:false})}});
app.post('/v1/operation',async(q,s)=>{try{const {op,payload}=validateAuthorityRequest(q.body, trustedHostPaths());const p:any=payload;let out:any;
switch(op){
case 'ping': out={ok:(await req('GET','/_ping')).status===200};break;
case 'image.inspect': out=await json('GET',`${API}/images/${enc(p.ref)}/json`);break;
case 'container.listManaged': {const all=p.all?1:0;const resource=exactAssessmentInventoryResource(p.filters);if(resource){
  const wanted=Object.fromEntries((p.filters.label as string[]).map((label:string)=>{const at=label.indexOf('=');return [label.slice(0,at),label.slice(at+1)];}));
  try {const rows=await boundedInventoryJson(`${API}/containers/json?all=${all}&filters=${filters(p.filters)}`);
    if(!Array.isArray(rows))throw new BridgeError('DOCKER_UNAVAILABLE','assessment inventory is malformed',502);
    if(rows.length>BE9_INVENTORY_MAX_ROWS || new Set(rows.map(c=>c?.Id)).size!==rows.length)throw new BridgeError('DOCKER_UNAVAILABLE','assessment inventory exceeds resource limit',502);
    out=[];for(const c of rows){if(typeof c?.Id!=='string'||!/^[0-9a-f]{64}$/.test(c.Id))throw new BridgeError('FORBIDDEN_POLICY','assessment inventory identity is malformed',403);
      exactInventoryLabels(c.Labels,wanted,resource);
      const inspected=await assertContainer(c.Id,true);exactInventoryLabels(inspected.Config?.Labels,wanted,resource);out.push(c);}
  }catch(error){throw inventoryFailure(error)}
}else{const rows=await json('GET',`${API}/containers/json?all=${all}&filters=${filters(p.filters??{})}`);out=[];for(const c of rows){try{await assertContainer(c.Id);out.push(c)}catch{}}}break;}
case 'container.inspectManaged': out=await assertContainer(String(p.id));break;
case 'container.createManaged': {const body=rec(p.body);const containerIdentity=managedIdentity(body.Labels);for(const mount of managedVolumeMounts(body)){const volume=await managedVolume(mount.Source);validateManagedVolumeAttachment(containerIdentity,volume.identity,mount);}out=await json('POST',`${API}/containers/create?name=${enc(p.name)}`,body);break;}
case 'container.execManaged': {if(p.action==='create'){const c=await assertContainer(String(p.containerId));const body=rec(p.body);const identity=managedIdentityFromTrustedContainer(c);if(identity)validateManagedExecForIdentity(identity,body);out=await json('POST',`${API}/containers/${enc(p.containerId)}/exec`,body);}else if(p.action==='inspect'){out=await json('GET',`${API}/exec/${enc(p.execId)}/json`);await assertContainer(String(out.ContainerID));}else throw new BridgeError('FORBIDDEN_POLICY','unsupported exec action',403);break;}
case 'container.archiveWriteManaged': {const c=await assertContainer(String(p.containerId));const identity=managedIdentityFromTrustedContainer(c);if(identity)validateManagedArchivePath(identity,'write',p.path);}{const data=Buffer.from(String(p.base64??''),'base64');if(data.length>9*1024*1024)throw new BridgeError('FORBIDDEN_POLICY','archive write exceeds authority cap',403);const r=await docker.request({method:'PUT',path:`${API}/containers/${enc(p.containerId)}/archive?path=${enc(p.path)}&noOverwriteDirNonDir=1`,headers:{'content-type':'application/x-tar'},body:data});const t=await r.body.text();if(r.statusCode>=400)throw new BridgeError('DOCKER_UNAVAILABLE',`archive write failed: ${r.statusCode} ${t.slice(0,160)}`,502);out={ok:true};}break;
case 'container.startManaged': await assertContainer(String(p.id));await req('POST',`${API}/containers/${enc(p.id)}/start`);out={ok:true};break;
case 'container.waitManaged': {await assertManagedContainer(String(p.id));const ac=new AbortController();const ms=Math.max(1,Math.min(Number(p.timeoutMs??300000),300000));const timer=setTimeout(()=>ac.abort(),ms);try{const r=await docker.request({method:'POST',path:`${API}/containers/${enc(p.id)}/wait`,signal:ac.signal});const t=await r.body.text();if(r.statusCode>=400)throw new BridgeError('DOCKER_UNAVAILABLE','container wait failed',502);out=JSON.parse(t);}catch(e){if(ac.signal.aborted)throw new BridgeError('DOCKER_UNAVAILABLE','container wait timeout',504);throw e}finally{clearTimeout(timer)}break;}
case 'container.logsManaged': await assertContainer(String(p.id));{const cap=Math.max(1,Math.min(Number(p.maxBytes??1048576),8*1024*1024))+65536;const r=await docker.request({method:'GET',path:`${API}/containers/${enc(p.id)}/logs?stdout=1&stderr=1&timestamps=0`});if(r.statusCode>=400)throw new BridgeError('DOCKER_UNAVAILABLE','container logs failed',502);let chunks:Buffer[]=[];let n=0;for await(const c of r.body as any){const b=Buffer.from(c);const take=Math.min(b.length,cap-n);if(take>0){chunks.push(b.subarray(0,take));n+=take}if(n>=cap){(r.body as any).destroy();break}}out={base64:Buffer.concat(chunks).toString('base64')};}break;
case 'container.stopManaged': await assertContainer(String(p.id));await req('POST',`${API}/containers/${enc(p.id)}/stop?t=${Number(p.timeoutSec??2)}`);out={ok:true};break;
case 'container.restartManaged': await assertContainer(String(p.id));await req('POST',`${API}/containers/${enc(p.id)}/restart?t=${Number(p.timeoutSec??10)}`);out={ok:true};break;
case 'container.killManaged': await assertManagedContainer(String(p.id));await req('POST',`${API}/containers/${enc(p.id)}/kill?signal=${enc(p.signal??'SIGKILL')}`);out={ok:true};break;
case 'container.removeManaged': await assertManagedContainer(String(p.id));await req('DELETE',`${API}/containers/${enc(p.id)}?force=1&v=1`);out={ok:true};break;
case 'volume.createManaged': {
  const intended = managedIdentity(p.labels);
  out = await serializedVolumeMutation(String(p.name), async () => {
    const created = await json('POST',`${API}/volumes/create`, {
      Name: p.name, Driver: 'local', Labels: p.labels,
    });
    if (intended.scope === 'sandbox' && intended.resource === 'assessment-source') {
      const actual = managedIdentity(created?.Labels);
      if (created?.Name !== p.name || actual.resource !== 'assessment-source'
        || actual.assessment !== intended.assessment || actual.job !== intended.job) {
        throw new BridgeError('FORBIDDEN_POLICY','assessment source volume creation ownership mismatch',403);
      }
    }
    return created;
  });
  break;
}
case 'volume.listManaged': {const resource=exactAssessmentInventoryResource(p.filters);if(resource==='assessment-source'){
  const wanted=Object.fromEntries((p.filters.label as string[]).map((label:string)=>{const at=label.indexOf('=');return [label.slice(0,at),label.slice(at+1)];}));
  try{const r=await boundedInventoryJson(`${API}/volumes?filters=${filters(p.filters)}`);
    if(r?.Volumes!==null&&!Array.isArray(r?.Volumes))throw new BridgeError('DOCKER_UNAVAILABLE','assessment inventory is malformed',502);
    if((r.Volumes??[]).length>BE9_INVENTORY_MAX_ROWS || new Set((r.Volumes??[]).map((v:any)=>v?.Name)).size!==(r.Volumes??[]).length)throw new BridgeError('DOCKER_UNAVAILABLE','assessment inventory exceeds resource limit',502);
    out={Volumes:[]};for(const v of r.Volumes??[]){if(typeof v?.Name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/.test(v.Name))throw new BridgeError('FORBIDDEN_POLICY','assessment inventory identity is malformed',403);
      exactInventoryLabels(v.Labels,wanted,resource);out.Volumes.push(v);}
  }catch(error){throw inventoryFailure(error)}
}else{const r=await json('GET',`${API}/volumes?filters=${filters(p.filters??{})}`);out={Volumes:[]};for(const v of r?.Volumes??[]){try{managedIdentity(v.Labels);out.Volumes.push(v)}catch{}}}break;}
case 'volume.removeManaged': {
  if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 255
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p.name)) {
    throw new BridgeError('FORBIDDEN_POLICY','managed volume removal name is invalid',403);
  }
  out = await serializedVolumeMutation(p.name, async () => {
    const volume = await assertManagedVolume(p.name);
    // An absent volume must never be followed by DELETE-by-name: another
    // allocation could create that name between absence and deletion.
    if (!volume) return { ok: true };
    const identity = managedIdentity(volume.Labels);
    if (identity.scope === 'sandbox' && identity.resource === 'assessment-source') {
      const expected = rec(p.expectedAssessmentSourceOwner);
      if (Object.keys(expected).length !== 2
        || typeof expected.assessmentId !== 'string'
        || typeof expected.executionId !== 'string'
        || !/^assessment_[0-9a-f]{24}$/.test(expected.assessmentId)
        || !/^job_[0-9a-f]{32}$/.test(expected.executionId)
        || identity.assessment !== expected.assessmentId
        || identity.job !== expected.executionId) {
        throw new BridgeError('FORBIDDEN_POLICY','assessment source volume ownership mismatch',403);
      }
    } else if (p.expectedAssessmentSourceOwner !== undefined) {
      throw new BridgeError('FORBIDDEN_POLICY','unexpected assessment volume ownership assertion',403);
    }
    // Atomicity is established only among requests to this broker instance.
    // Docker exposes no conditional volume DELETE; out-of-band raw socket
    // mutation remains an explicit external trust-boundary limitation.
    await req('DELETE',`${API}/volumes/${enc(p.name)}?force=1`);
    return { ok: true };
  });
  break;
}
case 'network.createManaged': managedIdentity(p.labels);out=await json('POST',`${API}/networks/create`,{Name:p.name,Driver:'bridge',Internal:Boolean(p.internal),CheckDuplicate:true,Labels:p.labels});break;
case 'network.listManaged': {const rows=await json('GET',`${API}/networks?filters=${filters(p.filters??{})}`);out=[];for(const n of rows){try{managedIdentity(n.Labels);out.push(n)}catch{}}break;}
case 'network.connectManaged': {const network=await managedNetwork(String(p.network));const container=await assertManagedContainer(String(p.container));validateManagedNetworkAttachment(network.identity,container.identity);const aliases=Array.isArray(p.aliases)&&p.aliases.every((x:unknown)=>typeof x==='string')?p.aliases:[];if(aliases.length>1||aliases.some((x:string)=>x!=='egress-proxy'))throw new BridgeError('FORBIDDEN_POLICY','network aliases are restricted to the governed proxy alias',403);await req('POST',`${API}/networks/${enc(p.network)}/connect`,{Container:p.container,...(aliases.length?{EndpointConfig:{Aliases:aliases}}:{})});out={ok:true};break;}
case 'network.removeManaged': await assertManagedNetwork(String(p.id));await req('DELETE',`${API}/networks/${enc(p.id)}`);out={ok:true};break;
default: throw new BridgeError('FORBIDDEN_POLICY',`operation ${op} requires streaming endpoint`,403);
}s.json(out??{ok:true});}catch(e){const b=asBridgeError(e);s.status(b.httpStatus).json(b.toJSON())}});
app.post('/v1/stream/:op',async(q,s)=>{try{const op=q.params.op;const p:any=rec(q.body);if(op==='container.execManaged'){const ei:any=await json('GET',`${API}/exec/${enc(p.execId)}/json`);await assertContainer(String(ei.ContainerID));if(p.action!=='start')throw new BridgeError('FORBIDDEN_POLICY','unsupported exec stream action',403);const r=await docker.request({method:'POST',path:`${API}/exec/${enc(p.execId)}/start`,headers:{'content-type':'application/json'},body:JSON.stringify({Detach:false,Tty:false})});if(r.statusCode>=400){const t=await r.body.text();throw new BridgeError('DOCKER_UNAVAILABLE',`exec start failed: ${r.statusCode} ${t.slice(0,160)}`,502)};s.status(200);s.flushHeaders();(r.body as any).pipe(s);return;}if(op==='container.archiveReadManaged'){const c=await assertContainer(String(p.containerId));const identity=managedIdentityFromTrustedContainer(c);if(identity)validateManagedArchivePath(identity,'read',p.path);const r=await docker.request({method:'GET',path:`${API}/containers/${enc(p.containerId)}/archive?path=${enc(p.path)}`});if(r.statusCode>=400){const t=await r.body.text();throw new BridgeError(r.statusCode===404?'FILE_NOT_FOUND':'DOCKER_UNAVAILABLE','archive read failed',r.statusCode===404?404:502)};const h=r.headers['x-docker-container-path-stat'];if(typeof h==='string')s.setHeader('x-docker-container-path-stat',h);(r.body as any).pipe(s);return;}throw new BridgeError('FORBIDDEN_POLICY','unsupported streaming operation',403)}catch(e){if(s.headersSent){s.destroy();return}const b=asBridgeError(e);s.status(b.httpStatus).json(b.toJSON())}});
app.listen(PORT,'0.0.0.0',()=>console.log(`docker-authority listening on ${PORT}`));
