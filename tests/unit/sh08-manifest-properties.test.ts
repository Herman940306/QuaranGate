import { describe, expect, it } from 'vitest';
import {
  canonicalStringify, validateSnapshotManifest, type SnapshotManifest,
} from '../../src/executor/agents/canonicalJson.js';
import {
  createInstallationManifest, installationManifestDigest, validateInstallationManifest, type InstallationManifest,
} from '../../src/lifecycle/manifest.js';
import { runProperty } from '../helpers/sh08Property.js';

const shaA='a'.repeat(64), shaB='b'.repeat(64), shaC='c'.repeat(64), gitA='1'.repeat(40);
function installation(): InstallationManifest { return createInstallationManifest({
  schemaVersion:1,installationId:'123e4567-e89b-42d3-a456-426614174000',lifecycleState:'INSTALLED',productVersion:'0.1.0',sourceCommit:gitA,
  releaseDigest:shaA,configSchemaVersion:1,stateSchemaVersion:1,installedAt:'2026-09-15T00:00:00.000Z',updatedAt:'2026-09-15T00:00:00.000Z',
  components:['control-center','executor','gateway'],integrations:{providers:{kiro:{state:'DEFERRED_ENTITLEMENT'},copilot:{state:'DEFERRED_ENTITLEMENT'},ollama:{state:'CONFIGURED'}},ide:{state:'UPSTREAM_P7_PENDING'},github:{state:'CONFIGURED',selectedRepositories:['Herman/QuaranGate']}},
  roots:{install:'/opt/quarangate',state:'/var/lib/quarangate',evidence:'/var/lib/quarangate/evidence',models:'/var/lib/quarangate/models',backups:'/var/lib/quarangate/backups',cache:'/var/cache/quarangate'},
  runtimeIdentities:[{component:'gateway',reference:'quarangate-gateway:git-1111111111111111111111111111111111111111',digest:`sha256:${shaB}`}],
  migrations:[{id:'config-0-to-1',kind:'CONFIG',fromVersion:0,toVersion:1,digest:shaC},{id:'state-0-to-1',kind:'STATE',fromVersion:0,toVersion:1,digest:shaB}],
  startupRegistrations:[{id:'quarangate-user-startup',mechanism:'WINDOWS_TASK_SCHEDULER_WSL',identityDigest:shaB,enabled:true}],
  clientRegistrations:[{id:'chatgpt',generation:1,authorityDigest:shaC,state:'ACTIVE'}],
  sessionResumePolicy:{mutating:'REFUSE_ON_SOURCE_DRIFT_NEW_SESSION_NO_INHERITED_AUTHORITY',readOnly:'RE_ATTEST_REAUTHORIZE_NEW_GENERATION_ZERO_MUTATION_AUTHORITY',historicalMemory:'CONTEXT_ONLY_NEVER_AUTHORITY'},
  health:{state:'HEALTHY',verifiedAt:'2026-09-15T00:00:00.000Z'},
}); }

describe('SH-08 canonical manifest properties',()=>{
  it('canonical JSON is invariant to recursively permuted object insertion order',()=>{
    runProperty('canonical-json-order', {seed:0x08e001,iterations:1500}, (rng)=>{
      const entries=Array.from({length:1+rng.int(8)},(_,i)=>[`k${i}_${rng.nextU32().toString(16)}`, {z:rng.int(1000),a:`v${rng.nextU32()}`,nested:{q:rng.int(10),b:rng.bool()}}] as const);
      const a=Object.fromEntries(entries);
      const b=Object.fromEntries([...entries].reverse().map(([k,v])=>[k,{nested:{b:v.nested.b,q:v.nested.q},a:v.a,z:v.z}]));
      expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    });
  });

  it('snapshot manifests reject arbitrary unknown top-level and entry fields instead of dropping them',()=>{
    const base: SnapshotManifest={version:1,entries:[{path:'src/a.ts',kind:'file',mode:0o644,sizeBytes:1,contentHash:shaA}]};
    expect(()=>validateSnapshotManifest(base)).not.toThrow();
    runProperty('snapshot-unknown-fields',{seed:0x08e002,iterations:800},(rng,i)=>{
      const key=`unknown_${i}_${rng.nextU32().toString(16)}`;
      expect(()=>validateSnapshotManifest({...base,[key]:'x'} as unknown as SnapshotManifest)).toThrow();
      const mutated={...base,entries:[{...base.entries[0]!,[key]:'x'}]};
      expect(()=>validateSnapshotManifest(mutated as unknown as SnapshotManifest)).toThrow();
    });
  });

  it('installation manifests are stable across JSON round-trip and reject generated unknown authority-bearing fields',()=>{
    const base=installation(); const digest=installationManifestDigest(base);
    expect(installationManifestDigest(validateInstallationManifest(JSON.parse(JSON.stringify(base))))).toBe(digest);
    runProperty('installation-strict-fields',{seed:0x08e003,iterations:700},(rng,i)=>{
      const key=`unknown_${i}_${rng.nextU32().toString(16)}`;
      expect(()=>validateInstallationManifest({...base,[key]:'x'})).toThrow();
      const nested=structuredClone(base) as any; nested.runtimeIdentities[0][key]='/var/run/docker.sock';
      expect(()=>validateInstallationManifest(nested)).toThrow();
    });
  });

  it('mutable latest runtime identities never validate',()=>{
    runProperty('manifest-no-latest',{seed:0x08e004,iterations:400},(rng)=>{
      const m=structuredClone(installation()) as any;
      const prefix=`repo${rng.int(10000)}`;
      m.runtimeIdentities[0].reference=rng.bool()?`${prefix}:latest`:`${prefix}/latest`;
      if(String(m.runtimeIdentities[0].reference).endsWith(':latest')) expect(()=>validateInstallationManifest(m)).toThrow();
    });
  });
});
