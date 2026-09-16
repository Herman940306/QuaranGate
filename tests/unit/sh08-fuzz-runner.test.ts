import { describe, expect, it } from 'vitest';
import { FuzzPrng, mutateFuzzInput, parseFuzzArgs, SH08_COVERAGE_SAMPLE_INTERVAL } from '../../scripts/security-fuzz.mjs';

describe('SH-08 bounded coverage-guided fuzz runner contract', () => {
  it('uses fixed bounded defaults and refuses unbounded/tiny configurations', () => {
    const d=parseFuzzArgs([]);
    expect(d).toEqual({ build:false, seed:0x51f08a11, iterations:2000, maxInputBytes:1024, maxCorpus:256, maxRuntimeMs:20000 });
    expect(SH08_COVERAGE_SAMPLE_INTERVAL).toBe(16);
    expect(() => parseFuzzArgs(['--iterations','0'])).toThrow(/iterations/u);
    expect(() => parseFuzzArgs(['--iterations','100001'])).toThrow(/iterations/u);
    expect(() => parseFuzzArgs(['--max-input-bytes','512'])).toThrow(/max-input-bytes/u);
    expect(() => parseFuzzArgs(['--max-corpus','5000'])).toThrow(/max-corpus/u);
    expect(() => parseFuzzArgs(['--max-runtime-ms','300001'])).toThrow(/max-runtime-ms/u);
  });

  it('is deterministic for the same seed and never exceeds the byte bound', () => {
    const run=(seed:number)=>{
      const rng=new FuzzPrng(seed); const corpus=['alpha','../beta','😀/x']; const out:string[]=[];
      for(let i=0;i<100;i++){const value=mutateFuzzInput(corpus[rng.int(corpus.length)]!,rng,corpus,1024); expect(Buffer.byteLength(value,'utf8')).toBeLessThanOrEqual(1024); out.push(value);}
      return out;
    };
    expect(run(0x12345678)).toEqual(run(0x12345678));
    expect(run(0x12345678)).not.toEqual(run(0x12345679));
  });

  it('never performs network/package acquisition in its source contract', async () => {
    const source=await import('node:fs/promises').then((fs)=>fs.readFile('scripts/security-fuzz.mjs','utf8'));
    expect(source).not.toMatch(/npm\s+(?:install|ci)|curl\s|wget\s|docker\s+pull/iu);
    expect(source).toContain("import inspector from 'node:inspector'");
    expect(source).toContain('Profiler.startPreciseCoverage');
  });
});
