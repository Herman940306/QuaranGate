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

export const PRODUCTION_REQUIRED_PAYLOAD_FILES = [
  'compose.yaml',
  'dist/installer/cli.js',
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
