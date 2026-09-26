import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  ReleasePackageError,
  verifyReleasePackageManifest,
  type ReleasePackageImage,
  type ReleasePackageManifest,
} from './releasePackage.js';

/**
 * The concrete v1 runtime launched by the production installer. The generic
 * release schema intentionally stays reusable; this profile is the stricter
 * admission boundary for the owner-facing Windows/WSL installer.
 */
export const PRODUCTION_RUNTIME_COMPONENTS = [
  'docker-authority',
  'executor',
  'gateway',
  'projects-work',
] as const;

export type ProductionRuntimeComponent = (typeof PRODUCTION_RUNTIME_COMPONENTS)[number];

export const PRODUCTION_INSTALLER_RUNTIME_MODULES = [
  'dist/executor/agentConfig.js',
  'dist/executor/agents/applyPolicy.js',
  'dist/executor/agents/canonicalJson.js',
  'dist/gateway/config.js',
  'dist/installer/cli.js',
  'dist/installer/hostProbe.js',
  'dist/installer/productInstaller.js',
  'dist/installer/productionInstaller.js',
  'dist/installer/productionRelease.js',
  'dist/installer/releasePackage.js',
  'dist/installer/runtimeConfig.js',
  'dist/installer/wslProductionPlatform.js',
  'dist/lifecycle/engine.js',
  'dist/lifecycle/manifest.js',
  'dist/lifecycle/pathOwnership.js',
  'dist/lifecycle/planner.js',
  'dist/lifecycle/productionDriver.js',
  'dist/lifecycle/safeFilesystem.js',
  'dist/shared/agents.js',
  'dist/shared/errors.js',
  'dist/shared/executionFabric.js',
] as const;

export const PRODUCTION_INSTALLER_RUNTIME_PACKAGES = ['yaml', 'zod'] as const;

export const PRODUCTION_REQUIRED_PAYLOAD_FILES = [
  'compose.yaml',
  ...PRODUCTION_INSTALLER_RUNTIME_MODULES,
  'node_modules/yaml/package.json',
  'node_modules/zod/package.json',
  'package-lock.json',
  'package.json',
  'scripts/installer-bootstrap.mjs',
  'scripts/production-runtime-start.sh',
  'scripts/production-runtime-stop.sh',
  'scripts/windows/QuaranGate-Setup.cmd',
  'scripts/windows/QuaranGate-Setup.ps1',
  'scripts/windows/Inspect-QuaranGateProductionAutostart.ps1',
  'scripts/windows/Install-QuaranGateProductionAutostart.ps1',
  'scripts/windows/Open-QuaranGateControlCenter.ps1',
  'scripts/windows/Remove-QuaranGateProductionAutostart.ps1',
] as const;

export interface ProductionReleaseProfile {
  manifest: ReleasePackageManifest;
  images: Array<ReleasePackageImage & { component: ProductionRuntimeComponent }>;
}

function packageAncestors(relative: string): string[] {
  const parts = relative.split('/');
  const out: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    out.push(parts.slice(0, index).join('/'));
  }
  return out;
}

export function verifyProductionReleasePayloadClosure(
  payloadRootInput: string,
  manifestInput: ReleasePackageManifest,
): { files: number; directories: number } {
  const manifest = verifyReleasePackageManifest(manifestInput);
  const root = path.resolve(payloadRootInput);
  if (root !== payloadRootInput || root === path.parse(root).root) {
    throw new ReleasePackageError('PRODUCTION_RELEASE_ROOT_INVALID', 'Production release payload root must be one canonical absolute non-root path');
  }
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new ReleasePackageError('PRODUCTION_RELEASE_ROOT_INVALID', 'Production release payload root is missing');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root) {
    throw new ReleasePackageError('PRODUCTION_RELEASE_ROOT_INVALID', 'Production release payload root must be one real non-symlink directory');
  }

  const expectedFiles = new Set(manifest.files.map((file) => file.path));
  const expectedDirectories = new Set(manifest.files.flatMap((file) => packageAncestors(file.path)));
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();

  const walk = (absolute: string, relativePrefix: string): void => {
    for (const entry of readdirSync(absolute).sort()) {
      const relative = relativePrefix ? `${relativePrefix}/${entry}` : entry;
      const candidate = path.join(absolute, entry);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new ReleasePackageError('PRODUCTION_RELEASE_PAYLOAD_NOT_CLOSED', `Production release contains a symlink: ${relative}`);
      }
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relative)) {
          throw new ReleasePackageError('PRODUCTION_RELEASE_PAYLOAD_NOT_CLOSED', `Production release contains an unmanifested directory: ${relative}`);
        }
        seenDirectories.add(relative);
        walk(candidate, relative);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new ReleasePackageError('PRODUCTION_RELEASE_PAYLOAD_NOT_CLOSED', `Production release contains an unsafe filesystem entry: ${relative}`);
      }
      if (!expectedFiles.has(relative)) {
        throw new ReleasePackageError('PRODUCTION_RELEASE_PAYLOAD_NOT_CLOSED', `Production release contains an unmanifested file: ${relative}`);
      }
      seenFiles.add(relative);
    }
  };
  walk(root, '');

  if (seenFiles.size !== expectedFiles.size || [...expectedFiles].some((file) => !seenFiles.has(file))) {
    throw new ReleasePackageError('PRODUCTION_RELEASE_PAYLOAD_NOT_CLOSED', 'Production release is missing one or more manifest-declared files');
  }
  if (seenDirectories.size !== expectedDirectories.size || [...expectedDirectories].some((dir) => !seenDirectories.has(dir))) {
    throw new ReleasePackageError('PRODUCTION_RELEASE_PAYLOAD_NOT_CLOSED', 'Production release directory tree does not match the manifest');
  }
  return { files: seenFiles.size, directories: seenDirectories.size };
}

function referenceMatchesComponent(image: ReleasePackageImage, sourceCommit: string): boolean {
  return image.reference.includes(sourceCommit) && image.reference.includes(image.component);
}

export function verifyProductionReleaseProfile(manifestInput: ReleasePackageManifest): ProductionReleaseProfile {
  const manifest = verifyReleasePackageManifest(manifestInput);
  const actual = manifest.images.map((image) => image.component);
  const expected = [...PRODUCTION_RUNTIME_COMPONENTS];
  if (actual.length !== expected.length || actual.some((component, index) => component !== expected[index])) {
    throw new ReleasePackageError(
      'PRODUCTION_RELEASE_COMPONENTS_INVALID',
      `Production release component inventory must be exactly: ${expected.join(', ')}`,
    );
  }
  if (manifest.lifecycle.components.length !== expected.length
    || manifest.lifecycle.components.some((component, index) => component !== expected[index])) {
    throw new ReleasePackageError(
      'PRODUCTION_RELEASE_COMPONENTS_INVALID',
      'Production release lifecycle component inventory does not match the installable runtime',
    );
  }
  const payloadPaths = new Set(manifest.files.map((file) => file.path));
  const missingPayloads = PRODUCTION_REQUIRED_PAYLOAD_FILES.filter((file) => !payloadPaths.has(file));
  if (missingPayloads.length > 0) {
    throw new ReleasePackageError(
      'PRODUCTION_RELEASE_PAYLOAD_INCOMPLETE',
      `Production release is missing required install payloads: ${missingPayloads.join(', ')}`,
    );
  }
  const allowedRuntimeDependencyPrefixes = PRODUCTION_INSTALLER_RUNTIME_PACKAGES
    .map((name) => `node_modules/${name}/`);
  const unexpectedRuntimeDependencies = manifest.files
    .map((file) => file.path)
    .filter((file) => file.startsWith('node_modules/')
      && !allowedRuntimeDependencyPrefixes.some((prefix) => file.startsWith(prefix)));
  if (unexpectedRuntimeDependencies.length > 0) {
    throw new ReleasePackageError(
      'PRODUCTION_RELEASE_DEPENDENCY_INVALID',
      `Production installer payload contains an unaudited runtime dependency: ${unexpectedRuntimeDependencies[0]}`,
    );
  }
  const executableScripts = new Set([
    'scripts/production-runtime-start.sh',
    'scripts/production-runtime-stop.sh',
  ]);
  for (const file of manifest.files) {
    if (executableScripts.has(file.path) && file.mode !== 0o755) {
      throw new ReleasePackageError(
        'PRODUCTION_RELEASE_PAYLOAD_MODE_INVALID',
        `Production runtime script must be executable: ${file.path}`,
      );
    }
  }

  for (const image of manifest.images) {
    if (!referenceMatchesComponent(image, manifest.sourceCommit)) {
      throw new ReleasePackageError(
        'PRODUCTION_RELEASE_IMAGE_INVALID',
        `Production image reference for ${image.component} must bind its service identity and exact source commit`,
      );
    }
  }
  return {
    manifest,
    images: manifest.images as Array<ReleasePackageImage & { component: ProductionRuntimeComponent }>,
  };
}
