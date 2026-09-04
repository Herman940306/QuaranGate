import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_HOSTS,
  analyzeLockFile,
  analyzeLockText,
  assertAcceptedResponseStatus,
  canonicalJson,
  createDescriptor,
  createManifest,
  prepareBundle,
  verifyBundle,
} from '../../scripts/npm-offline-bundle.mjs';

interface Fixture {
  root: string;
  artifactRoot: string;
  bundlePath: string;
  lockfilePath: string;
  packageJsonPath: string;
  descriptorPath: string;
  artifactPath: string;
  artifactName: string;
  artifactBytes: Buffer;
  lockText: string;
}

const temporaryRoots: string[] = [];

function digestFor(bytes: Buffer): { integrity: string; hex: string } {
  const digest = createHash('sha512').update(bytes).digest();
  return { integrity: `sha512-${digest.toString('base64')}`, hex: digest.toString('hex') };
}

function lockObject(integrity: string, extraPackages: Record<string, unknown> = {}) {
  return {
    name: 'synthetic-root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'synthetic-root', version: '1.0.0' },
      'node_modules/synthetic-package': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/synthetic-package/-/synthetic-package-1.0.0.tgz',
        integrity,
      },
      ...extraPackages,
    },
  };
}

async function makeFixture(options: { bytes?: Buffer; extraPackages?: Record<string, unknown> } = {}): Promise<Fixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'quarangate-npm-bundle-test-'));
  temporaryRoots.push(root);
  const artifactRoot = path.join(root, 'artifacts');
  const artifactBytes = options.bytes ?? Buffer.from('synthetic npm tarball bytes\n');
  const { integrity, hex } = digestFor(artifactBytes);
  const lockText = canonicalJson(lockObject(integrity, options.extraPackages));
  const lockfilePath = path.join(root, 'package-lock.json');
  const packageJsonPath = path.join(root, 'package.json');
  await fsp.writeFile(lockfilePath, lockText);
  await fsp.writeFile(packageJsonPath, canonicalJson({ name: 'synthetic-root', version: '1.0.0', private: true }));
  const analysis = await analyzeLockFile(lockfilePath);
  const bundlePath = path.join(artifactRoot, analysis.packageLockSha256);
  const tarballsPath = path.join(bundlePath, 'tarballs');
  await fsp.mkdir(tarballsPath, { recursive: true });
  const artifactName = `sha512-${hex}.tgz`;
  const artifactPath = path.join(tarballsPath, artifactName);
  await fsp.writeFile(artifactPath, artifactBytes);
  const sizes = new Map([[hex, artifactBytes.length]]);
  const manifest = createManifest(analysis, sizes);
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  await fsp.writeFile(path.join(bundlePath, 'manifest.json'), manifestBytes);
  const descriptorPath = path.join(root, 'npm-dependencies.json');
  await fsp.writeFile(descriptorPath, canonicalJson(createDescriptor(manifest, manifestBytes)));
  return {
    root, artifactRoot, bundlePath, lockfilePath, packageJsonPath, descriptorPath,
    artifactPath, artifactName, artifactBytes, lockText,
  };
}

async function verify(fixture: Fixture) {
  return verifyBundle({
    bundlePath: fixture.bundlePath,
    lockfilePath: fixture.lockfilePath,
    descriptorPath: fixture.descriptorPath,
  });
}

async function rewriteManifest(fixture: Fixture, transform: (manifest: Record<string, any>) => void) {
  const manifestPath = path.join(fixture.bundlePath, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as Record<string, any>;
  transform(manifest);
  await fsp.writeFile(manifestPath, canonicalJson(manifest));
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe('governed npm offline bundle', () => {
  it('U1 generates a byte-deterministic canonical manifest', async () => {
    const fixture = await makeFixture();
    const analysis = await analyzeLockFile(fixture.lockfilePath);
    const { hex } = digestFor(fixture.artifactBytes);
    const sizes = new Map([[hex, fixture.artifactBytes.length]]);
    expect(canonicalJson(createManifest(analysis, sizes))).toBe(canonicalJson(createManifest(analysis, sizes)));
    expect(canonicalJson(createManifest(analysis, sizes))).toMatch(/\n$/u);
  });

  it('U2 rejects a package-lock whose hash no longer matches the descriptor', async () => {
    const fixture = await makeFixture();
    await fsp.appendFile(fixture.lockfilePath, ' ');
    await expect(verify(fixture)).rejects.toThrow(/canonical lock-derived value/u);
  });

  it('U3 rejects a missing required artifact', async () => {
    const fixture = await makeFixture();
    await fsp.unlink(fixture.artifactPath);
    await expect(verify(fixture)).rejects.toThrow(/unexpected or missing artifacts/u);
  });

  it('U4 rejects an artifact with corrupted bytes', async () => {
    const fixture = await makeFixture();
    const bytes = Buffer.from(fixture.artifactBytes);
    bytes[0] = bytes[0]! ^ 0xff;
    await fsp.writeFile(fixture.artifactPath, bytes);
    await expect(verify(fixture)).rejects.toThrow(/SHA-512 mismatch/u);
  });

  it('U5 rejects a wrong SHA-512 asserted by the manifest', async () => {
    const fixture = await makeFixture();
    const wrong = digestFor(Buffer.from('wrong')).integrity;
    await rewriteManifest(fixture, (manifest) => { manifest.entries[0].integrity = wrong; });
    await expect(verify(fixture)).rejects.toThrow(/canonical lock-derived value/u);
  });

  it('U6 rejects an extra content-addressed artifact', async () => {
    const fixture = await makeFixture();
    const extra = digestFor(Buffer.from('extra'));
    await fsp.writeFile(path.join(fixture.bundlePath, 'tarballs', `sha512-${extra.hex}.tgz`), 'extra');
    await expect(verify(fixture)).rejects.toThrow(/unexpected or missing artifacts/u);
  });

  it('U7 rejects any unexpected bundle-root file', async () => {
    const fixture = await makeFixture();
    await fsp.writeFile(path.join(fixture.bundlePath, 'evidence.txt'), 'unexpected');
    await expect(verify(fixture)).rejects.toThrow(/unexpected or missing entries/u);
  });

  it('U8 rejects symlinks and manifest path traversal', async () => {
    const fixture = await makeFixture();
    const original = path.join(fixture.root, 'original-artifact.tgz');
    await fsp.rename(fixture.artifactPath, original);
    await fsp.symlink(original, fixture.artifactPath);
    await expect(verify(fixture)).rejects.toThrow(/non-symlink|hard-linked/u);
    await fsp.unlink(fixture.artifactPath);
    await fsp.rename(original, fixture.artifactPath);
    await rewriteManifest(fixture, (manifest) => { manifest.entries[0].tarball = '../escape.tgz'; });
    await expect(verify(fixture)).rejects.toThrow(/unsafe tarball path/u);
  });

  it('U9 rejects a non-HTTPS resolved URL', () => {
    const bytes = Buffer.from('x');
    const lock = lockObject(digestFor(bytes).integrity) as any;
    lock.packages['node_modules/synthetic-package'].resolved = 'http://registry.npmjs.org/synthetic-package/-/synthetic-package-1.0.0.tgz';
    expect(() => analyzeLockText(canonicalJson(lock))).toThrow(/not HTTPS/u);
  });

  it('U10 rejects wrong hosts, URL credentials, and non-443 ports', () => {
    const integrity = digestFor(Buffer.from('x')).integrity;
    for (const resolved of [
      'https://registry.npmjs.org.example/synthetic.tgz',
      'https://user:pass@registry.npmjs.org/synthetic.tgz',
      'https://registry.npmjs.org:444/synthetic.tgz',
    ]) {
      const lock = lockObject(integrity) as any;
      lock.packages['node_modules/synthetic-package'].resolved = resolved;
      expect(() => analyzeLockText(canonicalJson(lock))).toThrow(/not allowed|credentials|port/u);
    }
  });

  it('U11 fails closed on every redirect class', () => {
    for (const status of [300, 301, 302, 303, 307, 308, 399]) {
      expect(() => assertAcceptedResponseStatus(status)).toThrow(/STOP_PREPARATION_REDIRECT/u);
    }
    expect(() => assertAcceptedResponseStatus(200)).not.toThrow();
  });

  it('U12 rejects missing integrity', () => {
    const lock = lockObject(digestFor(Buffer.from('x')).integrity) as any;
    delete lock.packages['node_modules/synthetic-package'].integrity;
    expect(() => analyzeLockText(canonicalJson(lock))).toThrow(/missing integrity/u);
  });

  it('U13 rejects non-SHA512, multiple, and malformed integrity values', () => {
    for (const integrity of ['sha256-YQ==', 'sha512-YQ==', 'sha512-YQ== sha512-Yg==']) {
      expect(() => analyzeLockText(canonicalJson(lockObject(integrity)))).toThrow(/sha512|malformed/u);
    }
  });

  it('U14 handles duplicate lock entries deterministically with one artifact', async () => {
    const bytes = Buffer.from('duplicate');
    const { integrity, hex } = digestFor(bytes);
    const resolved = 'https://registry.npmjs.org/shared/-/shared-1.0.0.tgz';
    const lock = lockObject(integrity, {
      'node_modules/other/node_modules/shared': { version: '1.0.0', resolved, integrity },
    }) as any;
    lock.packages['node_modules/synthetic-package'].resolved = resolved;
    const analysis = analyzeLockText(canonicalJson(lock));
    const manifest = createManifest(analysis, new Map([[hex, bytes.length]]));
    expect(manifest.packageEntryCount).toBe(2);
    expect(manifest.artifactCount).toBe(1);
    expect(new Set(manifest.entries.map((entry: any) => entry.tarball)).size).toBe(1);
  });

  it('U15 rejects descriptor and manifest disagreement', async () => {
    const fixture = await makeFixture();
    const descriptor = JSON.parse(await fsp.readFile(fixture.descriptorPath, 'utf8'));
    descriptor.artifactCount += 1;
    await fsp.writeFile(fixture.descriptorPath, canonicalJson(descriptor));
    await expect(verify(fixture)).rejects.toThrow(/bundle descriptor does not match/u);
  });

  it('U16 rejects credential-like and opaque cache baggage', async () => {
    for (const name of ['.npmrc', '.env', '_logs', '_npx', 'docker-config.json']) {
      const fixture = await makeFixture();
      await fsp.writeFile(path.join(fixture.bundlePath, name), 'prohibited');
      await expect(verify(fixture)).rejects.toThrow(/unexpected or missing entries/u);
      await fsp.rm(fixture.root, { recursive: true, force: true });
      temporaryRoots.splice(temporaryRoots.indexOf(fixture.root), 1);
    }
  });

  it('U17 reuses an existing valid bundle without calling the downloader', async () => {
    const fixture = await makeFixture();
    let calls = 0;
    const result = await prepareBundle({
      lockfilePath: fixture.lockfilePath,
      packageJsonPath: fixture.packageJsonPath,
      artifactRoot: fixture.artifactRoot,
      download: async () => { calls += 1; throw new Error('must not download'); },
    });
    expect(result.reusedExisting).toBe(true);
    expect(calls).toBe(0);
  });

  it('U18 never overwrites or repairs an existing invalid bundle', async () => {
    const fixture = await makeFixture();
    const marker = path.join(fixture.bundlePath, '.npmrc');
    await fsp.writeFile(marker, 'preserve-invalid-state');
    let calls = 0;
    await expect(prepareBundle({
      lockfilePath: fixture.lockfilePath,
      packageJsonPath: fixture.packageJsonPath,
      artifactRoot: fixture.artifactRoot,
      download: async () => { calls += 1; return 1; },
    })).rejects.toThrow(/unexpected or missing entries/u);
    expect(calls).toBe(0);
    expect(await fsp.readFile(marker, 'utf8')).toBe('preserve-invalid-state');
  });

  it('U19 derives artifact filenames only from the content digest', async () => {
    const fixture = await makeFixture();
    const { hex } = digestFor(fixture.artifactBytes);
    expect(fixture.artifactName).toBe(`sha512-${hex}.tgz`);
    expect(fixture.artifactName).not.toContain('synthetic-package');
    const result = await verify(fixture);
    expect(result.artifactCount).toBe(1);
  });

  it('U20 leaves the canonical repository package-lock byte-for-byte untouched', async () => {
    const lockfile = new URL('../../package-lock.json', import.meta.url);
    const before = fs.readFileSync(lockfile);
    const analysis = await analyzeLockFile(lockfile);
    expect(analysis.packageLockSha256).toBe('31688b0a46cb5051e069ff049bbafd34752ace10dfb9dac3a60c9a3fef5258e5');
    expect(fs.readFileSync(lockfile)).toEqual(before);
  });

  it('accepts a complete valid bundle bound to the allowed endpoint policy', async () => {
    const fixture = await makeFixture();
    const result = await verify(fixture);
    expect(result).toMatchObject({ packageEntryCount: 1, artifactCount: 1, totalFiles: 3 });
    const manifest = JSON.parse(await fsp.readFile(path.join(fixture.bundlePath, 'manifest.json'), 'utf8'));
    expect(manifest.allowedHosts).toEqual(ALLOWED_HOSTS);
  });

  it('R1 keeps runtime Compose parsing independent while builds retain a fail-closed sentinel', () => {
    const compose = fs.readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8');
    const sentinelContexts = compose.match(/npm_deps: "\$\{QUARANGATE_NPM_BUNDLE_PATH:-\.\/build\}"/gu) ?? [];
    expect(sentinelContexts).toHaveLength(2);
    expect(compose).not.toContain('QUARANGATE_NPM_BUNDLE_PATH:?');

    const acceptance = fs.readFileSync(new URL('../../scripts/accept-npm-offline-build.mjs', import.meta.url), 'utf8');
    expect(acceptance).toContain('RUNTIME_COMPOSE_WITHOUT_BUNDLE');
    expect(acceptance).toContain("BUILD_WITHOUT_VALID_BUNDLE = 'REFUSED'");
    expect(acceptance).toContain("'--network=none', '--pull=false', '--no-cache'");
  });
});
