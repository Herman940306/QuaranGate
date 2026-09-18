import { describe, expect, it } from 'vitest';
import {
  createReleasePackageManifest,
  type ReleasePackageManifest,
} from '../../src/installer/releasePackage.js';
import {
  PRODUCTION_INSTALLER_RUNTIME_MODULES,
  PRODUCTION_INSTALLER_RUNTIME_PACKAGES,
  PRODUCTION_REQUIRED_PAYLOAD_FILES,
  verifyProductionReleaseProfile,
} from '../../src/installer/productionRelease.js';

const commit = 'a'.repeat(40);
const digest = (c: string) => `sha256:${c.repeat(64)}`;

function manifest(
  images: ReleasePackageManifest['images'] = [
    { component: 'docker-authority', reference: `quarangate:docker-authority-${commit}`, digest: digest('1') },
    { component: 'executor', reference: `quarangate:executor-${commit}`, digest: digest('2') },
    { component: 'gateway', reference: `quarangate:gateway-${commit}`, digest: digest('3') },
    { component: 'projects-work', reference: `quarangate:projects-work-${commit}`, digest: digest('4') },
  ],
): ReleasePackageManifest {
  return createReleasePackageManifest({
    schemaVersion: 1,
    productVersion: '1.0.0',
    sourceCommit: commit,
    createdAt: '2026-09-18T00:00:00.000Z',
    architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
    signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
    lifecycle: {
      configSchemaVersion: 0,
      stateSchemaVersion: 0,
      components: images.map((image) => image.component).sort(),
      migrations: [],
    },
    files: [...PRODUCTION_REQUIRED_PAYLOAD_FILES].sort().map((relative, index) => ({
      path: relative,
      sizeBytes: 1,
      digest: (index % 16).toString(16).repeat(64),
      mode: relative === 'scripts/production-runtime-start.sh'
        || relative === 'scripts/production-runtime-stop.sh'
        ? 0o755 as const
        : 0o644 as const,
    })),
    images: [...images].sort((a, b) => a.component.localeCompare(b.component)),
  });
}

describe('P9 production release profile', () => {
  it('accepts only the exact installable runtime component inventory', () => {
    const verified = verifyProductionReleaseProfile(manifest());
    expect(verified.images.map((image) => image.component)).toEqual([
      'docker-authority', 'executor', 'gateway', 'projects-work',
    ]);
  });

  it.each([
    ['missing projects-work', ['docker-authority', 'executor', 'gateway']],
    ['missing docker authority', ['executor', 'gateway', 'projects-work']],
    ['unexpected component', ['docker-authority', 'executor', 'gateway', 'projects-work', 'sidecar']],
  ])('refuses %s', (_label, components) => {
    const images = components.map((component, index) => ({
      component,
      reference: `quarangate:${component}-${commit}`,
      digest: `sha256:${String(index + 1).padStart(64, '0')}`,
    }));
    expect(() => verifyProductionReleaseProfile(manifest(images))).toThrow(/production release component inventory/iu);
  });

  it('requires service-specific immutable references bound to the release source commit', () => {
    const bad = manifest().images.map((image) => image.component === 'gateway'
      ? { ...image, reference: 'quarangate:gateway-other' }
      : image);
    expect(() => verifyProductionReleaseProfile(manifest(bad))).toThrow(/image reference/iu);
  });
  it('refuses a release that omits an installer/runtime entrypoint', () => {
    const value = manifest();
    const { manifestDigest: _manifestDigest, ...identity } = value;
    const files = value.files.filter((file) => file.path !== 'scripts/production-runtime-start.sh');
    const incomplete = createReleasePackageManifest({
      ...identity,
      files,
    });
    expect(() => verifyProductionReleaseProfile(incomplete)).toThrow(/missing required install payloads/iu);
  });

  it('binds the audited installer module graph and only yaml/zod package roots', () => {
    expect(PRODUCTION_INSTALLER_RUNTIME_MODULES).toContain('dist/installer/cli.js');
    expect(PRODUCTION_INSTALLER_RUNTIME_MODULES).toContain('dist/lifecycle/productionDriver.js');
    expect(PRODUCTION_INSTALLER_RUNTIME_MODULES).toContain('dist/executor/agentConfig.js');
    expect(PRODUCTION_INSTALLER_RUNTIME_MODULES).toContain('dist/gateway/config.js');
    expect(PRODUCTION_INSTALLER_RUNTIME_PACKAGES).toEqual(['yaml', 'zod']);
    expect(PRODUCTION_REQUIRED_PAYLOAD_FILES).toContain('node_modules/yaml/package.json');
    expect(PRODUCTION_REQUIRED_PAYLOAD_FILES).toContain('node_modules/zod/package.json');
  });

  it('refuses arbitrary node_modules packages even when they are signed into the manifest', () => {
    const value = manifest();
    const { manifestDigest: _manifestDigest, ...identity } = value;
    const files = [...value.files, {
      path: 'node_modules/left-pad/package.json',
      sizeBytes: 1,
      digest: 'f'.repeat(64),
      mode: 0o644 as const,
    }].sort((left, right) => left.path.localeCompare(right.path));
    const bloated = createReleasePackageManifest({ ...identity, files });
    expect(() => verifyProductionReleaseProfile(bloated)).toThrow(/unaudited runtime dependency/iu);
  });

});
