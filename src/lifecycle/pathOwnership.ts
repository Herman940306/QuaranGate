import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const CONTROL = /[\u0000-\u001f\u007f]/u;

export type LifecycleRootName = 'state' | 'evidence' | 'models' | 'backups' | 'cache';

export interface LifecycleRoots {
  state: string;
  evidence: string;
  models: string;
  backups: string;
  cache: string;
}

export interface ProjectRoot {
  id: string;
  path: string;
}

export interface RootOwnershipInput {
  install: string;
  lifecycle: LifecycleRoots;
  projects: ProjectRoot[];
}

export interface AttestedRootOwnership {
  install: string;
  lifecycle: LifecycleRoots;
  projects: ProjectRoot[];
  backupSourceExclusions: string[];
}

export class RootOwnershipError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RootOwnershipError';
  }
}

function syntacticCanonical(input: string, label: string): string {
  if (typeof input !== 'string' || CONTROL.test(input) || input.includes('\\') || !path.posix.isAbsolute(input)) {
    throw new RootOwnershipError('ROOT_PATH_INVALID', `${label} must be an absolute WSL/Linux path`);
  }
  const normalized = path.posix.normalize(input).replace(/\/+$/u, '') || '/';
  if (normalized !== input.replace(/\/+$/u, '') || normalized === '/') {
    throw new RootOwnershipError('ROOT_PATH_INVALID', `${label} must be canonical and cannot be the filesystem root`);
  }
  return normalized;
}

/**
 * Resolve physical identity through the nearest existing ancestor. This catches
 * symlink, junction-equivalent WSL mounts, and reparse aliases even when the
 * final directory has not been created yet.
 */
export function attestPhysicalPath(input: string, label = 'path'): string {
  const canonical = syntacticCanonical(input, label);
  let ancestor = canonical;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = path.posix.dirname(ancestor);
    if (parent === ancestor) {
      throw new RootOwnershipError('ROOT_ATTESTATION_FAILED', `${label} has no attestable ancestor`);
    }
    missing.unshift(path.posix.basename(ancestor));
    ancestor = parent;
  }

  const linkStat = lstatSync(ancestor);
  if (!linkStat.isDirectory() && !linkStat.isSymbolicLink() && missing.length > 0) {
    throw new RootOwnershipError('ROOT_ATTESTATION_FAILED', `${label} crosses a non-directory ancestor`);
  }

  const physicalAncestor = realpathSync.native(ancestor).replace(/\/+$/u, '') || '/';
  if (!statSync(physicalAncestor).isDirectory()) {
    throw new RootOwnershipError('ROOT_ATTESTATION_FAILED', `${label} is not a directory`);
  }
  const physical = path.posix.resolve(physicalAncestor, ...missing);
  if (physical === '/') {
    throw new RootOwnershipError('ROOT_PATH_INVALID', `${label} resolves to the filesystem root`);
  }
  return physical;
}

function contains(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

function overlaps(left: string, right: string): boolean {
  return left === right || contains(left, right) || contains(right, left);
}

function lifecycleEntries(roots: LifecycleRoots): Array<[LifecycleRootName, string]> {
  return [
    ['state', roots.state],
    ['evidence', roots.evidence],
    ['models', roots.models],
    ['backups', roots.backups],
    ['cache', roots.cache],
  ];
}

function stateOwnedChildAllowed(
  leftName: LifecycleRootName,
  left: string,
  rightName: LifecycleRootName,
  right: string,
): boolean {
  const dedicated = new Set<LifecycleRootName>(['evidence', 'models', 'backups']);
  return (leftName === 'state' && dedicated.has(rightName) && contains(left, right))
    || (rightName === 'state' && dedicated.has(leftName) && contains(right, left));
}

export function validateRootOwnership(input: RootOwnershipInput): AttestedRootOwnership {
  const install = attestPhysicalPath(input.install, 'install root');
  const lifecycle = Object.fromEntries(
    lifecycleEntries(input.lifecycle).map(([name, value]) => [
      name,
      attestPhysicalPath(value, `${name} root`),
    ]),
  ) as unknown as LifecycleRoots;
  const projects = input.projects.map((project) => ({
    id: project.id,
    path: attestPhysicalPath(project.path, `project ${project.id}`),
  }));

  for (const [name, root] of lifecycleEntries(lifecycle)) {
    if (overlaps(install, root)) {
      throw new RootOwnershipError(
        'INSTALL_LIFECYCLE_OVERLAP',
        `Install root and lifecycle ${name} root must be physically disjoint`,
      );
    }
  }

  const entries = lifecycleEntries(lifecycle);
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const [leftName, left] = entries[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [rightName, right] = entries[rightIndex]!;
      if (left === right) {
        throw new RootOwnershipError(
          'LIFECYCLE_ROOT_ALIAS',
          `Lifecycle roots ${leftName} and ${rightName} resolve to the same physical directory`,
        );
      }
      if (!overlaps(left, right) || stateOwnedChildAllowed(leftName, left, rightName, right)) continue;
      if (leftName === 'backups' || rightName === 'backups') {
        throw new RootOwnershipError(
          'BACKUP_RECURSION',
          'Backup destination may not contain or be contained by another lifecycle category outside the explicit state-owned hierarchy',
        );
      }
      throw new RootOwnershipError(
        'LIFECYCLE_ROOT_OVERLAP',
        `Lifecycle roots ${leftName} and ${rightName} have ambiguous physical ownership`,
      );
    }
  }

  for (const project of projects) {
    if (overlaps(project.path, install)) {
      throw new RootOwnershipError(
        'PROJECT_INSTALL_OVERLAP',
        `Project ${project.id} and install root physically overlap`,
      );
    }
    for (const [name, root] of entries) {
      if (overlaps(project.path, root)) {
        throw new RootOwnershipError(
          'PROJECT_LIFECYCLE_OVERLAP',
          `Project ${project.id} and lifecycle ${name} root physically overlap`,
        );
      }
    }
  }

  for (let leftIndex = 0; leftIndex < projects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < projects.length; rightIndex += 1) {
      if (overlaps(projects[leftIndex]!.path, projects[rightIndex]!.path)) {
        throw new RootOwnershipError('PROJECT_ROOT_OVERLAP', 'Project roots must be physically disjoint');
      }
    }
  }

  const backupSourceExclusions = contains(lifecycle.state, lifecycle.backups)
    ? [lifecycle.backups]
    : [];

  return {
    install,
    lifecycle,
    projects,
    backupSourceExclusions,
  };
}
