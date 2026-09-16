#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import inspector from 'node:inspector';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULTS = Object.freeze({
  seed: 0x51f08a11,
  iterations: 2_000,
  maxInputBytes: 1_024,
  maxCorpus: 256,
  maxRuntimeMs: 20_000,
});

export const SH08_COVERAGE_SAMPLE_INTERVAL = 16;

export function parseFuzzArgs(argv = process.argv.slice(2)) {
  const valueAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const intArg = (flag, fallback, min, max) => {
    const raw = valueAfter(flag); if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${flag} must be an integer ${min}..${max}`);
    return value;
  };
  return {
    build: argv.includes('--build'),
    seed: intArg('--seed', DEFAULTS.seed, 1, 0xffff_ffff),
    iterations: intArg('--iterations', DEFAULTS.iterations, 1, 100_000),
    maxInputBytes: intArg('--max-input-bytes', DEFAULTS.maxInputBytes, 1_024, 16_384),
    maxCorpus: intArg('--max-corpus', DEFAULTS.maxCorpus, 8, 4_096),
    maxRuntimeMs: intArg('--max-runtime-ms', DEFAULTS.maxRuntimeMs, 100, 300_000),
  };
}

export class FuzzPrng {
  constructor(seed) { this.state = (seed >>> 0) || 0x9e3779b9; }
  next() { let x=this.state; x^=x<<13; x^=x>>>17; x^=x<<5; this.state=x>>>0; return this.state; }
  int(max) { if (!Number.isSafeInteger(max) || max < 1) throw new Error('invalid PRNG bound'); return this.next()%max; }
  pick(values) { return values[this.int(values.length)]; }
}

const MUTATION_TOKENS = Object.freeze([
  '', '.', '..', '/', '//', '\\', '\0', '\n', '\r', '\t', ':', '@', '#', '!', '*', '?', '[', ']', '{', '}',
  'latest', 'sha256:', 'A'.repeat(43), '0'.repeat(64), '😀', 'é', '中', ' ', '"', "'", 'null', 'true', '[]', '{}',
]);

function boundUtf8(value, maxBytes) {
  const bytes=Buffer.from(String(value),'utf8');
  return bytes.length <= maxBytes ? String(value) : bytes.subarray(0,maxBytes).toString('utf8');
}

export function mutateFuzzInput(input, rng, corpus, maxBytes) {
  const cps=Array.from(input);
  const op=rng.int(7);
  if (op===0 || cps.length===0) cps.splice(rng.int(cps.length+1),0,...Array.from(rng.pick(MUTATION_TOKENS)));
  else if (op===1) cps.splice(rng.int(cps.length),1);
  else if (op===2) cps[rng.int(cps.length)]=rng.pick(MUTATION_TOKENS);
  else if (op===3) { const at=rng.int(cps.length+1); cps.splice(at,0,...cps.slice(Math.max(0,at-4),Math.min(cps.length,at+4))); }
  else if (op===4) { const at=rng.int(cps.length+1); cps.splice(at,0,...Array.from(rng.pick(corpus))); }
  else if (op===5) { const from=rng.int(cps.length); const count=1+rng.int(Math.max(1,cps.length-from)); cps.splice(from,count); }
  else cps.reverse();
  return boundUtf8(cps.join(''),maxBytes);
}

function post(session, method, params={}) {
  return new Promise((resolvePromise,reject)=>session.post(method,params,(err,result)=>err?reject(err):resolvePromise(result)));
}

function buildIfRequested(config) {
  if (!config.build) return;
  const tsc=resolve('node_modules/.bin/tsc');
  if (!existsSync(tsc)) throw new Error('local TypeScript compiler unavailable; no network acquisition is permitted');
  const result=spawnSync(tsc,['-p','tsconfig.json'],{encoding:'utf8',timeout:60_000,maxBuffer:16*1024*1024});
  if (result.error) throw new Error(`build failed to execute: ${result.error.code ?? result.error.message}`);
  if (result.status!==0) throw new Error(`build failed: ${(result.stderr||result.stdout||'').slice(0,2000)}`);
}

function errorMatcher(...ctors) { return (error) => ctors.some((Ctor)=>error instanceof Ctor); }

async function loadTargets() {
  const [errors,image,pathcheck,apply,before,artifact,github,auth,handshake,remote,canonical,redact] = await Promise.all([
    import('../dist/shared/errors.js'), import('../dist/shared/imageRef.js'), import('../dist/shared/pathcheck.js'),
    import('../dist/executor/agents/applyPolicy.js'), import('../dist/executor/agents/beforeCapture.js'),
    import('../dist/executor/agents/artifactReader.js'), import('../dist/executor/githubConfig.js'),
    import('../dist/shared/ideCompanionAuth.js'), import('../dist/shared/ideCompanionHandshake.js'),
    import('../dist/shared/ideCompanionRemoteTransport.js'), import('../dist/executor/agents/canonicalJson.js'),
    import('../dist/shared/redact.js'),
  ]);
  const bridge=errorMatcher(errors.BridgeError);
  const jsonOrBridge=(error)=>error instanceof SyntaxError || error instanceof errors.BridgeError;
  const sid=`ides_${'1'.repeat(32)}`; const oid=`ideo_${'2'.repeat(32)}`; const lease=`idectl_${'3'.repeat(32)}`;
  const secret=Buffer.alloc(32,0x51); const now=1_800_000_000_000;
  const authFrame=auth.signIdeCompanionEnvelope(secret,{version:1,enrollmentId:`iden_${'4'.repeat(32)}`,ideInstanceId:`ide_${'5'.repeat(32)}`,sessionId:sid,connectionGeneration:1,controllerLeaseId:lease,operationId:oid,capability:'request_review',nonce:Buffer.alloc(32,0x41).toString('base64url'),issuedAtMs:now-1000,expiresAtMs:now+10000,payloadSha256:auth.hashIdeCompanionPayload('review')});
  const hello={version:1,type:'hello',enrollmentId:`iden_${'4'.repeat(32)}`,ideInstanceId:`ide_${'5'.repeat(32)}`,runtimeInstanceId:`iderun_${'6'.repeat(32)}`,adapterId:'quarangate-vscode-companion',adapterVersion:'1.2.3',sessionId:sid,clientNonce:Buffer.alloc(32,0x42).toString('base64url')};
  const workspaceAttestation='{"bounded":true}';
  const attest=handshake.signIdeCompanionAttestFrame(secret,{version:1,type:'attest',enrollmentId:hello.enrollmentId,ideInstanceId:hello.ideInstanceId,runtimeInstanceId:hello.runtimeInstanceId,adapterId:hello.adapterId,adapterVersion:hello.adapterVersion,sessionId:sid,connectionGeneration:1,clientNonce:hello.clientNonce,serverChallenge:Buffer.alloc(32,0x43).toString('base64url'),issuedAtMs:now-1000,expiresAtMs:now+10000,payloadSha256:handshake.hashIdeCompanionWorkspaceAttestation(workspaceAttestation),workspaceAttestation});
  const serverFrame={version:1,type:'authorize_operation',sessionId:sid,connectionGeneration:1,commandSequence:1,operationId:oid,controllerLeaseId:lease,capability:'request_review',prompt:'review'};
  const clientFrame={version:1,type:'operation_authorized',sessionId:sid,connectionGeneration:1,commandSequence:1,operationId:oid,auth:authFrame,workspaceAttestation};
  const sha='a'.repeat(64);
  return [
    { name:'image-ref', match:'/dist/shared/imageRef.js', seeds:['ubuntu','ubuntu:v1','registry:5000/repo',`repo@sha256:${sha}`,'ubuntu:latest',''], run:(x)=>image.parseImageRef(x), expected:()=>false },
    { name:'workspace-path', match:'/dist/shared/pathcheck.js', seeds:['','a/b','../x','/etc/passwd','a\\b','a\0b'], run:(x)=>pathcheck.validateRelativePath(x), expected:bridge },
    { name:'apply-path', match:'/dist/executor/agents/applyPolicy.js', seeds:['src/a.ts','.git/config','../x','a*?.txt','[legacy]/a'], run:(x)=>apply.validateApplyPath(x), expected:bridge },
    { name:'guard-pattern', match:'/dist/executor/agents/applyPolicy.js', seeds:['**/*.pem','a\\?.txt','[legacy]','!important','a\\'], run:(x)=>apply.validateGuardPattern(x), expected:bridge },
    { name:'archive-path', match:'/dist/executor/agents/beforeCapture.js', seeds:['workspace/a','workspace/','../x','//workspace/a','a\\b'], run:(x)=>before.canonicalizeWorkspaceEntryPath(x), expected:bridge },
    { name:'evidence-path', match:'/dist/executor/agents/artifactReader.js', seeds:['artifact-manifest.json',`blobs/${sha.slice(0,2)}/${sha}`,'../secret','blobs/aa/bad'], run:(x)=>artifact.assertAllowedEvidencePath(x), expected:bridge },
    { name:'github-key', match:'/dist/executor/githubConfig.js', seeds:['Owner/repo','bad/repo/extra','../x','owner/repo'], run:(x)=>github.parseGitHubRepositoryKey(x), expected:bridge },
    { name:'ide-auth', match:'/dist/shared/ideCompanionAuth.js', seeds:[JSON.stringify(authFrame),'{}','{','[]'], run:(x)=>auth.parseIdeCompanionAuthFrame(x), expected:errorMatcher(auth.IdeCompanionAuthError) },
    { name:'ide-hello', match:'/dist/shared/ideCompanionHandshake.js', seeds:[handshake.serializeIdeCompanionHello(hello),'{}','{','[]'], run:(x)=>handshake.parseIdeCompanionHello(x), expected:errorMatcher(handshake.IdeCompanionHandshakeError) },
    { name:'ide-attest', match:'/dist/shared/ideCompanionHandshake.js', seeds:[handshake.serializeIdeCompanionAttest(attest),'{}','{','[]'], run:(x)=>handshake.parseIdeCompanionAttest(x), expected:errorMatcher(handshake.IdeCompanionHandshakeError) },
    { name:'ide-server-frame', match:'/dist/shared/ideCompanionRemoteTransport.js', seeds:[remote.serializeIdeRemoteServerFrame(serverFrame),'{}','{','[]'], run:(x)=>remote.parseIdeRemoteServerFrame(x), expected:errorMatcher(remote.IdeRemoteTransportError) },
    { name:'ide-client-frame', match:'/dist/shared/ideCompanionRemoteTransport.js', seeds:[remote.serializeIdeRemoteClientFrame(clientFrame),'{}','{','[]'], run:(x)=>remote.parseIdeRemoteClientFrame(x), expected:errorMatcher(remote.IdeRemoteTransportError) },
    { name:'snapshot-manifest', match:'/dist/executor/agents/canonicalJson.js', seeds:['{"entries":[],"version":1}','{}','[]','{'], run:(x)=>canonical.validateSnapshotManifest(JSON.parse(x)), expected:jsonOrBridge },
    { name:'change-set', match:'/dist/executor/agents/canonicalJson.js', seeds:['{"entries":[],"version":1}','{}','[]','{'], run:(x)=>canonical.validateChangeSet(JSON.parse(x)), expected:jsonOrBridge },
    { name:'redaction', match:'/dist/shared/redact.js', seeds:['token=secret-value','authorization: Bearer abcdefghijklmnop','mcpb_abcdefgh12345678','plain text'], run:(x)=>{ const out=redact.redact(x); if(out.length>x.length+32) throw new Error('redaction expanded output unexpectedly'); return out; }, expected:()=>false },
  ];
}

function coverageRanges(result, match) {
  const set=new Set();
  for (const script of result.result ?? []) {
    if (!String(script.url).includes(match)) continue;
    for (const fn of script.functions ?? []) for (const range of fn.ranges ?? []) if (range.count>0) set.add(`${range.startOffset}:${range.endOffset}`);
  }
  return set;
}

async function executeTarget(target,input) {
  try { target.run(input); return 'accepted'; }
  catch (error) { if(target.expected(error)) return 'rejected'; throw error; }
}

export async function runSecurityFuzz(config=parseFuzzArgs()) {
  buildIfRequested(config);
  const targets=await loadTargets();
  const session=new inspector.Session(); session.connect();
  await post(session,'Profiler.enable');
  await post(session,'Profiler.startPreciseCoverage',{callCount:true,detailed:true});
  const started=Date.now(); const summaries=[];
  try {
    for (let ti=0; ti<targets.length; ti++) {
      const target=targets[ti];
      const rng=new FuzzPrng((config.seed ^ Math.imul(ti+1,0x9e3779b1))>>>0);
      const corpus=[...new Set(target.seeds.map((x)=>boundUtf8(x,config.maxInputBytes)))];
      const seenCoverage=new Set(); let accepted=0; let rejected=0; let retained=corpus.length; let executed=0;
      const pendingCoverageCandidates=[];
      const sampleCoverage=async()=>{
        if(pendingCoverageCandidates.length===0) return;
        const cov=coverageRanges(await post(session,'Profiler.takePreciseCoverage'),target.match);
        let novel=false;
        for(const key of cov){if(!seenCoverage.has(key)){seenCoverage.add(key);novel=true;}}
        if(novel && corpus.length<config.maxCorpus){
          // A sampled batch is retained only when that batch opens at least one
          // previously unseen target range. Retaining the bounded batch rather
          // than guessing one causative mutation keeps corpus guidance honest.
          for(const input of pendingCoverageCandidates){
            if(corpus.length>=config.maxCorpus) break;
            if(!corpus.includes(input)){corpus.push(input);retained++;}
          }
        }
        pendingCoverageCandidates.length=0;
      };
      const runOne=async(input,iteration)=>{
        const outcome=await executeTarget(target,input); if(outcome==='accepted') accepted++; else rejected++; executed++;
        pendingCoverageCandidates.push(input);
        if(pendingCoverageCandidates.length>=SH08_COVERAGE_SAMPLE_INTERVAL) await sampleCoverage();
        if(Date.now()-started>config.maxRuntimeMs) throw new Error(`global runtime bound exceeded at ${target.name} seed=${config.seed} iteration=${iteration}`);
      };
      for (let i=0;i<target.seeds.length;i++) await runOne(corpus[i]??'',-1-i);
      await sampleCoverage();
      for (let i=0;i<config.iterations;i++) {
        const base=corpus[rng.int(corpus.length)] ?? '';
        const input=mutateFuzzInput(base,rng,corpus,config.maxInputBytes);
        try { await runOne(input,i); }
        catch(error){ throw new Error(`security fuzz failure target=${target.name} seed=${config.seed} iteration=${i} input=${JSON.stringify(input)} error=${error instanceof Error?error.message:String(error)}`,{cause:error}); }
      }
      await sampleCoverage();
      if(seenCoverage.size===0) throw new Error(`coverage guidance produced no target ranges for ${target.name}`);
      if(accepted===0) throw new Error(`target ${target.name} never exercised an accepted input; seed corpus/bounds are invalid`);
      summaries.push({name:target.name,executed,accepted,rejected,corpusSize:corpus.length,retained,coverageRanges:seenCoverage.size});
    }
  } finally {
    await post(session,'Profiler.stopPreciseCoverage').catch(()=>{}); session.disconnect();
  }
  const elapsedMs=Date.now()-started;
  const report={
    schemaVersion:1,status:'PASS',seed:config.seed,iterationsPerTarget:config.iterations,maxInputBytes:config.maxInputBytes,
    maxCorpus:config.maxCorpus,maxRuntimeMs:config.maxRuntimeMs,coverageSampleInterval:SH08_COVERAGE_SAMPLE_INTERVAL,elapsedMs,targetCount:summaries.length,
    totalExecutions:summaries.reduce((n,x)=>n+x.executed,0),coverageRanges:summaries.reduce((n,x)=>n+x.coverageRanges,0),targets:summaries,
  };
  return report;
}

const invoked=process.argv[1]?pathToFileURL(resolve(process.argv[1])).href:null;
if(invoked===import.meta.url){
  try { const report=await runSecurityFuzz(); process.stdout.write(`${JSON.stringify(report,null,2)}\n`); }
  catch(error){ process.stderr.write(`SECURITY_FUZZ_FAILED: ${error instanceof Error?error.message:String(error)}\n`); process.exitCode=1; }
}
