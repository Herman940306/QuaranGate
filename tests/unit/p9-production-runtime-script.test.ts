import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('P9 production runtime start cleanup', () => {
  it('covers explicit failure exits with EXIT cleanup and disarms cleanup only after full success', () => {
    const source = readFileSync(path.resolve('scripts/production-runtime-start.sh'), 'utf8');

    expect(source).toContain('started=0\ncompleted=0');
    expect(source).toContain('trap cleanup_partial EXIT');
    expect(source).toContain('if (( started )) && (( ! completed )); then');
    expect(source).toContain('"${core_args[@]}" down --remove-orphans');
    expect(source).toContain('"${projects_args[@]}" down --remove-orphans');
    expect(source).not.toContain('trap cleanup_partial ERR');

    const completed = source.indexOf('completed=1');
    const disarm = source.indexOf('trap - EXIT', completed);
    const pass = source.indexOf("printf 'PRODUCTION_RUNTIME_START=PASS");
    expect(completed).toBeGreaterThan(0);
    expect(disarm).toBeGreaterThan(completed);
    expect(pass).toBeGreaterThan(disarm);

    const start = source.indexOf('started=1');
    const firstExplicitPostStartFail = source.indexOf('|| fail "core service not healthy', start);
    expect(start).toBeGreaterThan(0);
    expect(firstExplicitPostStartFail).toBeGreaterThan(start);
    expect(completed).toBeGreaterThan(firstExplicitPostStartFail);
  });
});
