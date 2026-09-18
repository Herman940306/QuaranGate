import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createReleasePackageManifest,
  releaseSignaturePayload,
} from '../../src/installer/releasePackage.js';
import {
  PRODUCTION_REQUIRED_PAYLOAD_FILES,
  PRODUCTION_RUNTIME_COMPONENTS,
} from '../../src/installer/productionRelease.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => 'node:' + name)]);

function jsSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/gu),
    ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ].map((match) => match[1]!);
}

function normalizePackageRelative(value: string): string {
  return path.posix.normalize(value.replace(/^\.\//u, ''));
}

function resolvePackageImport(packageName: string, fromRelative: string, specifier: string): string {
  const packageRoot = path.join(process.cwd(), 'node_modules', packageName);
  const base = normalizePackageRelative(path.posix.join(path.posix.dirname(fromRelative), specifier));
  const ext = path.posix.extname(base);
  const candidates = ext
    ? [base]
    : [base + '.js', base + '.mjs', base + '.cjs', path.posix.join(base, 'index.js'), path.posix.join(base, 'index.mjs'), path.posix.join(base, 'index.cjs')];
  const resolved = candidates.find((candidate) => existsSync(path.join(packageRoot, ...candidate.split('/'))));
  if (!resolved) throw new Error(`Cannot resolve ${specifier} from ${packageName}/${fromRelative}`);
  return resolved;
}

function runtimePackageEntry(packageName: 'yaml' | 'zod'): string {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'node_modules', packageName, 'package.json'), 'utf8')) as {
    main?: string;
    module?: string;
    exports?: Record<string, { node?: string; import?: string }>;
  };
  if (packageName === 'yaml') return normalizePackageRelative(packageJson.exports?.['.']?.node ?? packageJson.main ?? './dist/index.js');
  return normalizePackageRelative(packageJson.exports?.['.']?.import ?? packageJson.module ?? packageJson.main ?? './index.js');
}

function runtimePackageFiles(packageName: 'yaml' | 'zod'): string[] {
  const packageRoot = path.join(process.cwd(), 'node_modules', packageName);
  const seen = new Set<string>(['package.json']);
  const visit = (relative: string): void => {
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = readFileSync(path.join(packageRoot, ...relative.split('/')), 'utf8');
    for (const specifier of jsSpecifiers(source)) {
      if (NODE_BUILTINS.has(specifier)) continue;
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        if (specifier === packageName) {
          visit(runtimePackageEntry(packageName));
          continue;
        }
        throw new Error(`Unexpected external dependency from ${packageName}: ${specifier}`);
      }
      visit(resolvePackageImport(packageName, relative, specifier));
    }
  };
  visit(runtimePackageEntry(packageName));
  return [...seen].map((relative) => `node_modules/${packageName}/${relative}`).sort();
}

function addRealRuntimePackages(payloads: Map<string, Buffer>): void {
  for (const packageName of ['yaml', 'zod'] as const) {
    for (const relative of runtimePackageFiles(packageName)) {
      payloads.set(relative, readFileSync(path.join(process.cwd(), ...relative.split('/'))));
    }
  }
}

function fixture(
  cliBytes = Buffer.from('export {};\n'),
  options: { realRuntimePackages?: boolean } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qg-bootstrap-'));
  const payloadRoot = path.join(root, 'payload');
  mkdirSync(payloadRoot, { recursive: true });

  const payloads = new Map<string, Buffer>();
  [...PRODUCTION_REQUIRED_PAYLOAD_FILES].sort().forEach((relative, index) => {
    let bytes = Buffer.from('payload-' + String(index) + '-' + relative, 'utf8');
    if (relative === 'package.json') bytes = Buffer.from('{"name":"quarangate-release","private":true,"type":"module"}\n');
    if (relative === 'package-lock.json') bytes = Buffer.from('{"name":"quarangate-release","lockfileVersion":3,"packages":{}}\n');
    if (relative === 'node_modules/yaml/package.json' || relative === 'node_modules/zod/package.json') {
      bytes = readFileSync(path.join(process.cwd(), ...relative.split('/')));
    }
    if (relative === 'dist/installer/cli.js') bytes = cliBytes;
    payloads.set(relative, bytes);
  });
  if (options.realRuntimePackages) addRealRuntimePackages(payloads);

  const files = [...payloads.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([relative, bytes]) => {
    const target = path.join(payloadRoot, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    const mode = relative === 'scripts/production-runtime-start.sh'
      || relative === 'scripts/production-runtime-stop.sh'
      ? 0o755 as const
      : 0o644 as const;
    writeFileSync(target, bytes, { mode });
    return { path: relative, sizeBytes: bytes.length, digest: sha256(bytes), mode };
  });

  const sourceCommit = 'a'.repeat(40);
  const images = [...PRODUCTION_RUNTIME_COMPONENTS].map((component, index) => ({
    component,
    reference: 'quarangate:' + component + '-' + sourceCommit,
    digest: 'sha256:' + String(index + 1).repeat(64),
  }));

  const manifest = createReleasePackageManifest({
    schemaVersion: 1,
    productVersion: '1.0.0',
    sourceCommit,
    createdAt: '2026-09-18T00:00:00.000Z',
    architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
    signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
    lifecycle: {
      configSchemaVersion: 0,
      stateSchemaVersion: 0,
      components: [...PRODUCTION_RUNTIME_COMPONENTS],
      migrations: [],
    },
    files,
    images,
  });

  const pair = generateKeyPairSync('ed25519');
  const proof = {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: 'release-key-a',
    manifestDigest: manifest.manifestDigest,
    signedAt: '2026-09-18T00:01:00.000Z',
    signature: sign(null, releaseSignaturePayload(manifest), pair.privateKey).toString('base64'),
  };
  const trust = {
    schemaVersion: 1,
    policyId: 'quarangate-production-release',
    trustedKeys: [{
      keyId: 'release-key-a',
      algorithm: 'Ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }],
  };

  const manifestFile = path.join(root, 'release-manifest.json');
  const signatureProofFile = path.join(root, 'release-signature.json');
  const trustPolicyFile = path.join(root, 'release-trust-policy.json');
  writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  writeFileSync(signatureProofFile, JSON.stringify(proof), { mode: 0o600 });
  writeFileSync(trustPolicyFile, JSON.stringify(trust), { mode: 0o600 });

  return {
    root,
    payloadRoot,
    packageRoot: payloadRoot,
    manifest,
    proof,
    trust,
    manifestFile,
    signatureProofFile,
    trustPolicyFile,
  };
}

function bootstrapVerify(input: {
  packageRoot: string;
  manifestFile: string;
  signatureProofFile: string;
  trustPolicyFile: string;
}) {
  const bootstrap = pathToFileURL(path.resolve('scripts/installer-bootstrap.mjs')).href;
  const source = `
    import { verifyBootstrapRelease } from ${JSON.stringify(bootstrap)};
    try {
      const result = verifyBootstrapRelease(JSON.parse(process.argv[1]));
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : 'bootstrap failed');
      process.exitCode = 1;
    }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source, JSON.stringify(input)], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
}

describe('P9 production release bootstrap trust root', () => {
  it('uses Node built-ins only and never imports the normal installer graph before verification', async () => {
    const text = await import('node:fs/promises').then((fs) => fs.readFile('scripts/installer-bootstrap.mjs', 'utf8'));
    const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
    expect(text).not.toMatch(/from\s+['"]\.\.?\//u);
  });

  it('accepts a closed payload only after manifest digest, detached signature and trust verification', () => {
    const value = fixture();
    const result = bootstrapVerify(value);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      manifestDigest: string;
      verifiedFiles: number;
    };
    expect(parsed.status).toBe('PASS');
    expect(parsed.manifestDigest).toBe(value.manifest.manifestDigest);
    expect(parsed.verifiedFiles).toBe(value.manifest.files.length);
  });

  it('delegates only from a private verified staging copy and removes it afterward', () => {
    const markerRoot = mkdtempSync(path.join(os.tmpdir(), 'qg-bootstrap-marker-'));
    const marker = path.join(markerRoot, 'delegation.json');
    const cliBytes = Buffer.from(
      'import { writeFileSync } from "node:fs";\n'
      + 'writeFileSync(process.env.QG_BOOTSTRAP_MARKER, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n',
      'utf8',
    );
    const value = fixture(cliBytes);
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/installer-bootstrap.mjs'),
      'plan-production',
      '--answers', path.join(value.root, 'unused-answers.json'),
      '--package-root', value.packageRoot,
      '--manifest', value.manifestFile,
      '--signature-proof', value.signatureProofFile,
      '--trust-policy', value.trustPolicyFile,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, QG_BOOTSTRAP_MARKER: marker },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    const delegated = JSON.parse(readFileSync(marker, 'utf8')) as { cwd: string; argv: string[] };
    expect(delegated.cwd).not.toBe(value.packageRoot);
    expect(path.basename(delegated.cwd)).toMatch(/^quarangate-release-bootstrap-/u);
    expect(delegated.argv[4]).toBe(delegated.cwd);
    expect(delegated.argv[4]).not.toBe(value.packageRoot);
    for (const [index, original] of [
      [6, value.manifestFile],
      [8, value.signatureProofFile],
      [10, value.trustPolicyFile],
    ] as const) {
      expect(delegated.argv[index]).not.toBe(original);
      expect(path.basename(path.dirname(delegated.argv[index]!))).toMatch(/^quarangate-release-bootstrap-meta-/u);
      expect(existsSync(delegated.argv[index]!)).toBe(false);
    }
    expect(existsSync(delegated.cwd)).toBe(false);
  });

  it('refuses opaque or comment-obscured runtime loaders that cannot be manifest-bound', () => {
    for (const source of [
      'const runtimePackage = "yaml";\nawait import(runtimePackage);\n',
      'await import/* hidden separator */("/tmp/quarangate-untrusted-runtime.mjs");\n',
      'require/* hidden separator */("/tmp/quarangate-untrusted-runtime.cjs");\n',
      'module/* hidden separator */.require("/tmp/quarangate-untrusted-runtime.cjs");\n',
      'import { createRequire } from "node:module";\nconst runtimeRequire = createRequire(import.meta.url);\nruntimeRequire("/tmp/quarangate-untrusted-runtime.cjs");\n',
    ]) {
      const value = fixture(Buffer.from(source, 'utf8'));
      const result = bootstrapVerify(value);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/opaque module load|manifest-bound|absolute module imports are refused/iu);
    }
  });

  it('normalizes comments before extracting static runtime imports', () => {
    const value = fixture(Buffer.from('import { readFileSync } from /* hidden separator */ "node:fs";\nvoid readFileSync;\n', 'utf8'));
    const result = bootstrapVerify(value);
    expect(result.status).toBe(0);
  });

  it('refuses absolute and unaudited package-subpath runtime imports', () => {
    const absolute = fixture(Buffer.from('import "/tmp/quarangate-untrusted-runtime.mjs";\n', 'utf8'));
    const absoluteResult = bootstrapVerify(absolute);
    expect(absoluteResult.status).toBe(1);
    expect(absoluteResult.stderr).toMatch(/absolute module imports are refused/iu);

    const subpath = fixture(Buffer.from('import YAMLUtil from "yaml/util";\nvoid YAMLUtil;\n', 'utf8'));
    const subpathResult = bootstrapVerify(subpath);
    expect(subpathResult.status).toBe(1);
    expect(subpathResult.stderr).toMatch(/unaudited package subpath/iu);
  });

  it('refuses an incomplete audited package runtime graph before CLI handoff', () => {
    const markerRoot = mkdtempSync(path.join(os.tmpdir(), 'qg-bootstrap-incomplete-runtime-'));
    const marker = path.join(markerRoot, 'executed.txt');
    const cliBytes = Buffer.from(
      'import YAML from "yaml";\n'
      + 'import { z } from "zod";\n'
      + 'import { writeFileSync } from "node:fs";\n'
      + 'writeFileSync(process.env.QG_BOOTSTRAP_MARKER, String(Boolean(YAML.parse)) + String(Boolean(z.object)));\n',
      'utf8',
    );
    const value = fixture(cliBytes);
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/installer-bootstrap.mjs'),
      'plan-production',
      '--answers', path.join(value.root, 'unused-answers.json'),
      '--package-root', value.packageRoot,
      '--manifest', value.manifestFile,
      '--signature-proof', value.signatureProofFile,
      '--trust-policy', value.trustPolicyFile,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, QG_BOOTSTRAP_MARKER: marker },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/runtime package|installer runtime import|missing from the manifest/iu);
    expect(existsSync(marker)).toBe(false);
  });

  it('proves the audited yaml and zod runtime package graph can execute from the verified staging copy', () => {
    const markerRoot = mkdtempSync(path.join(os.tmpdir(), 'qg-bootstrap-runtime-'));
    const marker = path.join(markerRoot, 'executed.txt');
    const cliBytes = Buffer.from(
      'import YAML from "yaml";\n'
      + 'import { z } from "zod";\n'
      + 'import { writeFileSync } from "node:fs";\n'
      + 'writeFileSync(process.env.QG_BOOTSTRAP_MARKER, JSON.stringify({ parsed: YAML.parse("a: 1").a, valid: z.object({ a: z.number() }).parse({ a: 1 }).a }));\n',
      'utf8',
    );
    const value = fixture(cliBytes, { realRuntimePackages: true });
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/installer-bootstrap.mjs'),
      'plan-production',
      '--answers', path.join(value.root, 'unused-answers.json'),
      '--package-root', value.packageRoot,
      '--manifest', value.manifestFile,
      '--signature-proof', value.signatureProofFile,
      '--trust-policy', value.trustPolicyFile,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, QG_BOOTSTRAP_MARKER: marker },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ parsed: 1, valid: 1 });
  });

  it('refuses an unmanifested executable before normal installer code can be loaded', () => {
    const value = fixture();
    writeFileSync(path.join(value.payloadRoot, 'evil.mjs'), 'throw new Error("executed");\n', { mode: 0o644 });
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unmanifested/iu);
  });

  it('refuses a symlink in the signed package tree', () => {
    const value = fixture();
    const victim = path.join(value.payloadRoot, 'compose.yaml');
    const link = path.join(value.payloadRoot, 'extra-link');
    symlinkSync(victim, link);
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/symlink|unmanifested/iu);
  });

  it('refuses a manifested file changed after signing', () => {
    const value = fixture();
    writeFileSync(path.join(value.payloadRoot, 'compose.yaml'), 'tampered', { mode: 0o644 });
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/size mismatch|digest mismatch/iu);
  });

  it('refuses release trust material co-located inside the payload root', () => {
    const value = fixture();
    const colocated = path.join(value.payloadRoot, 'trust.json');
    writeFileSync(colocated, JSON.stringify(value.trust), { mode: 0o600 });
    const result = bootstrapVerify({ ...value, trustPolicyFile: colocated });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/outside the payload root/iu);
  });

  it('refuses an extra directory even when it contains no files', () => {
    const value = fixture();
    mkdirSync(path.join(value.payloadRoot, 'unmanifested-dir'));
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unmanifested directory/iu);
  });

  it('refuses a symlinked directory in the package tree', () => {
    const value = fixture();
    symlinkSync(path.join(value.payloadRoot, 'scripts'), path.join(value.payloadRoot, 'scripts-link'), 'dir');
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/symlink/iu);
  });

  it('refuses a hard-linked package file', () => {
    const value = fixture();
    linkSync(path.join(value.payloadRoot, 'compose.yaml'), path.join(value.payloadRoot, 'compose-copy.yaml'));
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unsafe entry/iu);
  });

  it('refuses a missing manifest-declared file', () => {
    const value = fixture();
    rmSync(path.join(value.payloadRoot, 'compose.yaml'));
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/missing one or more manifest files/iu);
  });

  it('refuses a noncanonical package root path', () => {
    const value = fixture();
    const result = bootstrapVerify({ ...value, packageRoot: value.packageRoot + path.sep + '.' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/canonical absolute/iu);
  });

  it('refuses a symlinked package root', () => {
    const value = fixture();
    const alias = path.join(value.root, 'payload-link');
    symlinkSync(value.payloadRoot, alias, 'dir');
    const result = bootstrapVerify({ ...value, packageRoot: alias });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/real canonical directory/iu);
  });

  it('refuses a bad canonical manifest digest before package code can execute', () => {
    const value = fixture();
    writeFileSync(value.manifestFile, JSON.stringify({
      ...value.manifest,
      manifestDigest: '0'.repeat(64),
    }), { mode: 0o600 });
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/canonical digest mismatch/iu);
  });

  it('refuses malformed manifest schema', () => {
    const value = fixture();
    writeFileSync(value.manifestFile, JSON.stringify({
      ...value.manifest,
      unexpectedField: true,
    }), { mode: 0o600 });
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown or missing fields/iu);
  });

  it('refuses a signature proof that predates the signed release', () => {
    const value = fixture();
    writeFileSync(value.signatureProofFile, JSON.stringify({
      ...value.proof,
      signedAt: '2026-09-17T23:59:59.000Z',
    }), { mode: 0o600 });
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/signature proof is invalid/iu);
  });

  it('refuses a proof bound to the wrong manifest digest', () => {
    const value = fixture();
    writeFileSync(value.signatureProofFile, JSON.stringify({
      ...value.proof,
      manifestDigest: 'f'.repeat(64),
    }), { mode: 0o600 });
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/signature proof is invalid/iu);
  });

  it('refuses an untrusted signing key identity', () => {
    const value = fixture();
    writeFileSync(value.signatureProofFile, JSON.stringify({
      ...value.proof,
      keyId: 'unknown-release-key',
    }), { mode: 0o600 });
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/signing key is not trusted/iu);
  });

  it('refuses a detached signature that is cryptographically invalid', () => {
    const value = fixture();
    const other = generateKeyPairSync('ed25519');
    const badProof = {
      ...value.proof,
      signature: sign(null, releaseSignaturePayload(value.manifest), other.privateKey).toString('base64'),
    };
    writeFileSync(value.signatureProofFile, JSON.stringify(badProof), { mode: 0o600 });
    const result = bootstrapVerify(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/signature verification failed/iu);
  });

  it('never executes the normal installer CLI when any pre-trust check fails', () => {
    const markerRoot = mkdtempSync(path.join(os.tmpdir(), 'qg-bootstrap-block-marker-'));
    const marker = path.join(markerRoot, 'executed.txt');
    const value = fixture(Buffer.from(
      'import { writeFileSync } from "node:fs";\n'
      + 'writeFileSync(process.env.QG_BOOTSTRAP_MARKER, "executed");\n',
      'utf8',
    ));
    writeFileSync(path.join(value.payloadRoot, 'compose.yaml'), 'tampered', { mode: 0o644 });
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/installer-bootstrap.mjs'),
      'plan-production',
      '--answers', path.join(value.root, 'unused-answers.json'),
      '--package-root', value.packageRoot,
      '--manifest', value.manifestFile,
      '--signature-proof', value.signatureProofFile,
      '--trust-policy', value.trustPolicyFile,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, QG_BOOTSTRAP_MARKER: marker },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/INSTALLER_BOOTSTRAP_BLOCKED/iu);
    expect(existsSync(marker)).toBe(false);
  });
});
