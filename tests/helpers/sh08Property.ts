import { expect } from 'vitest';

/** Deterministic xorshift32 generator. Security property failures always report seed + iteration. */
export class Sh08Prng {
  private state: number;
  constructor(readonly seed: number) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }
  nextU32(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
  int(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) throw new Error('maxExclusive must be a positive safe integer');
    return this.nextU32() % maxExclusive;
  }
  bool(): boolean { return (this.nextU32() & 1) === 1; }
  pick<T>(values: readonly T[]): T { return values[this.int(values.length)]!; }
  string(alphabet: readonly string[], maxCodePoints: number, minCodePoints = 0): string {
    const length = minCodePoints + this.int(maxCodePoints - minCodePoints + 1);
    let out = '';
    for (let i = 0; i < length; i++) out += this.pick(alphabet);
    return out;
  }
}

export const HOSTILE_CODEPOINTS = [
  'a','Z','0','9','_','-','.','/','\\',' ',':','@','#','$','|','!','*','?','[',']','{','}','(',')',',','+','=',
  '\0','\n','\r','\t','\x7f','é','中','😀','́',
] as const;

export const SAFE_PATH_CODEPOINTS = [
  'a','b','c','X','Y','Z','0','1','2','_','-','.',' ','@','#','$','|','!','*','?','[',']','{','}','(',')',',','+','=','é','中','😀',
] as const;

export function runProperty(
  name: string,
  opts: { seed: number; iterations: number },
  body: (rng: Sh08Prng, iteration: number) => void,
): void {
  expect(opts.iterations).toBeGreaterThan(0);
  const rng = new Sh08Prng(opts.seed);
  for (let i = 0; i < opts.iterations; i++) {
    try { body(rng, i); }
    catch (error) {
      const rendered = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`${name} failed seed=0x${opts.seed.toString(16)} iteration=${i}: ${rendered}`, { cause: error });
    }
  }
}

export function mutateOneCodePoint(input: string, rng: Sh08Prng, alphabet: readonly string[] = HOSTILE_CODEPOINTS): string {
  const cps = Array.from(input);
  const op = rng.int(4);
  if (op === 0 || cps.length === 0) cps.splice(rng.int(cps.length + 1), 0, rng.pick(alphabet));
  else if (op === 1) cps.splice(rng.int(cps.length), 1);
  else if (op === 2) cps[rng.int(cps.length)] = rng.pick(alphabet);
  else {
    const at = rng.int(cps.length + 1);
    cps.splice(at, 0, rng.pick(alphabet), rng.pick(alphabet));
  }
  return cps.join('');
}
