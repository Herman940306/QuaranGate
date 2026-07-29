/**
 * A5 change-detection tests — deterministic, model-independent comparison of
 * the pristine baseline manifest against the post-run manifest.
 */
import { describe, it, expect } from 'vitest';
import {
  parseManifest, diffManifests, MAX_CHANGED_PATHS,
  type WorkspaceManifest,
} from '../../src/executor/agents/changeDetection.js';

function manifest(entries: [string, number, string][], extra: Partial<WorkspaceManifest> = {}): WorkspaceManifest {
  return {
    ok: true, count: entries.length, truncated: false,
    entries: entries.map(([path, size, sha]) => ({ path, size, sha })),
    ...extra,
  };
}

describe('parseManifest', () => {
  it('parses the tagged manifest line and ignores surrounding noise', () => {
    const line = JSON.stringify({ __manifest: true, ok: true, count: 1, truncated: false, entries: [['a.txt', 3, 'deadbeef']] });
    const m = parseManifest(`some log\n${line}\ntrailing log\n`);
    expect(m).not.toBeNull();
    expect(m!.ok).toBe(true);
    expect(m!.entries).toEqual([{ path: 'a.txt', size: 3, sha: 'deadbeef' }]);
  });
  it('returns null when there is no manifest line', () => {
    expect(parseManifest('nothing here\n{"not":"a manifest"}\n')).toBeNull();
  });
  it('propagates a walker error manifest', () => {
    const line = JSON.stringify({ __manifest: true, ok: false, count: 0, truncated: false, entries: [], error: 'EACCES' });
    const m = parseManifest(line + '\n');
    expect(m!.ok).toBe(false);
    expect(m!.error).toBe('EACCES');
  });
});

describe('diffManifests', () => {
  const baseline = manifest([
    ['keep.ts', 10, 'h_keep'],
    ['mod.ts', 20, 'h_mod_old'],
    ['gone.ts', 30, 'h_gone'],
  ]);

  it('detects added, modified, deleted and IGNORES unchanged', () => {
    const post = manifest([
      ['keep.ts', 10, 'h_keep'],       // unchanged
      ['mod.ts', 25, 'h_mod_new'],     // modified
      ['new.ts', 5, 'h_new'],          // added
      // gone.ts deleted
    ]);
    const d = diffManifests(baseline, post);
    expect(d.added).toEqual(['new.ts']);
    expect(d.modified).toEqual(['mod.ts']);
    expect(d.deleted).toEqual(['gone.ts']);
    expect(d.changedFiles).toEqual(['gone.ts', 'mod.ts', 'new.ts']); // sorted union
    expect(d.changedCount).toBe(3);
    expect(d.changedBytes).toBe(25 + 5); // added + modified post sizes
    expect(d.postFileCount).toBe(3);
    expect(d.truncated).toBe(false);
  });

  it('reports no changes when manifests are identical', () => {
    const d = diffManifests(baseline, baseline);
    expect(d.changedCount).toBe(0);
    expect(d.changedFiles).toEqual([]);
    expect(d.changedBytes).toBe(0);
  });

  it('diffHash is deterministic and distinguishes different change sets', () => {
    const postA = manifest([['keep.ts', 10, 'h_keep'], ['mod.ts', 25, 'x'], ['gone.ts', 30, 'h_gone']]);
    const postB = manifest([['keep.ts', 10, 'h_keep'], ['mod.ts', 30, 'y'], ['gone.ts', 30, 'h_gone']]);
    const a1 = diffManifests(baseline, postA).diffHash;
    const a2 = diffManifests(baseline, postA).diffHash;
    const b = diffManifests(baseline, postB).diffHash;
    expect(a1).toBe(a2);          // deterministic
    expect(a1).toBe(b);           // same set of changed PATHS -> same identity hash
    const postC = manifest([['keep.ts', 10, 'h_keep'], ['mod.ts', 20, 'h_mod_old'], ['gone.ts', 30, 'h_gone'], ['extra.ts', 1, 'z']]);
    expect(diffManifests(baseline, postC).diffHash).not.toBe(a1); // different paths -> different hash
  });

  it('marks truncated when an input manifest was truncated', () => {
    const post = manifest([['new.ts', 1, 'h']], { truncated: true });
    expect(diffManifests(baseline, post).truncated).toBe(true);
  });

  it('bounds the enumerated changed paths', () => {
    const many: [string, number, string][] = [];
    for (let i = 0; i < MAX_CHANGED_PATHS + 50; i++) many.push([`f${i}.txt`, 1, `h${i}`]);
    const d = diffManifests(manifest([]), manifest(many));
    expect(d.changedCount).toBe(MAX_CHANGED_PATHS + 50); // true count preserved
    expect(d.changedFiles.length).toBe(MAX_CHANGED_PATHS); // output bounded
    expect(d.truncated).toBe(true);
  });
});
