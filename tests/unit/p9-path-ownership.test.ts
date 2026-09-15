import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RootOwnershipError,
  validateRootOwnership,
} from '../../src/lifecycle/pathOwnership.js';

function fixture(): {
  base: string;
  install: string;
  state: string;
  evidence: string;
  models: string;
  backups: string;
  cache: string;
  project: string;
} {
  const base = mkdtempSync(path.join(tmpdir(), 'qg-p9-roots-'));
  const state = path.join(base, 'owned');
  const values = {
    base,
    install: path.join(base, 'app'),
    state,
    evidence: path.join(state, 'evidence'),
    models: path.join(state, 'models'),
    backups: path.join(state, 'backups'),
    cache: path.join(base, 'cache'),
    project: path.join(base, 'projects', 'customer'),
  };
  for (const value of Object.values(values).slice(1)) mkdirSync(value, { recursive: true });
  return values;
}

function validate(values: ReturnType<typeof fixture>, patch: Partial<ReturnType<typeof fixture>> = {}) {
  const roots = { ...values, ...patch };
  return validateRootOwnership({
    install: roots.install,
    lifecycle: {
      state: roots.state,
      evidence: roots.evidence,
      models: roots.models,
      backups: roots.backups,
      cache: roots.cache,
    },
    projects: [{ id: 'customer', path: roots.project }],
  });
}

describe('P9 physical project/lifecycle root isolation', () => {
  it('rejects the exact reviewer reproduction where every lifecycle root equals the project', () => {
    const roots = fixture();
    expect(() => validate(roots, {
      install: roots.project,
      state: roots.project,
      evidence: roots.project,
      models: roots.project,
      backups: roots.project,
      cache: roots.project,
    })).toThrow(RootOwnershipError);
  });

  it('rejects a lifecycle root inside a project root', () => {
    const roots = fixture();
    const project = path.join(roots.base, 'customer');
    const state = path.join(project, '.quarangate');
    mkdirSync(state, { recursive: true });
    expect(() => validate(roots, { project, state })).toThrow(/project.*lifecycle|lifecycle.*project/iu);
  });

  it('rejects a project inside a removable lifecycle root', () => {
    const roots = fixture();
    const project = path.join(roots.models, 'customer-source');
    mkdirSync(project, { recursive: true });
    expect(() => validate(roots, { project })).toThrow(/project.*lifecycle|lifecycle.*project/iu);
  });

  it('rejects install-root equality and containment with customer projects', () => {
    const roots = fixture();
    expect(() => validate(roots, { install: roots.project })).toThrow(/project.*install|install.*project/iu);
    const nestedInstall = path.join(roots.project, '.installed');
    mkdirSync(nestedInstall);
    expect(() => validate(roots, { install: nestedInstall })).toThrow(/project.*install|install.*project/iu);
  });

  it('rejects dangerous category equality and backup recursion', () => {
    const roots = fixture();
    expect(() => validate(roots, { evidence: roots.models })).toThrowError(
      expect.objectContaining<Partial<RootOwnershipError>>({ code: 'LIFECYCLE_ROOT_ALIAS' }),
    );

    const backupParent = path.join(roots.base, 'backup-parent');
    const stateInsideBackup = path.join(backupParent, 'state');
    mkdirSync(stateInsideBackup, { recursive: true });
    expect(() => validate(roots, { backups: backupParent, state: stateInsideBackup })).toThrowError(
      expect.objectContaining<Partial<RootOwnershipError>>({ code: 'BACKUP_RECURSION' }),
    );
  });

  it('allows the explicit state-root hierarchy with disjoint dedicated children', () => {
    const roots = fixture();
    const result = validate(roots);
    expect(result.lifecycle.state).toBe(roots.state);
    expect(result.lifecycle.backups).toBe(roots.backups);
  });

  it('uses physical identity so a symlink alias cannot bypass project isolation', () => {
    const roots = fixture();
    const projectAlias = path.join(roots.base, 'project-alias');
    symlinkSync(roots.state, projectAlias, 'dir');
    expect(() => validate(roots, { project: projectAlias })).toThrowError(
      expect.objectContaining<Partial<RootOwnershipError>>({ code: 'PROJECT_LIFECYCLE_OVERLAP' }),
    );
  });
});
