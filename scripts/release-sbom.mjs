#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Production npm release components: core plus the shipped VS Code/Cursor extensions.
// The ide-chat-spike tree is preserved feasibility evidence and is not a release component.
const DEFAULT_RELEASE_LOCKS = [
  'package-lock.json',
  'extensions/quarangate-vscode/package-lock.json',
  'extensions/quarangate-cursor/package-lock.json',
];

const args = process.argv.slice(2);
const outAt = args.indexOf('--output');
const output = outAt >= 0 ? args[outAt + 1] : undefined;
if (outAt >= 0 && !output) throw new Error('--output requires a path');

const requestedLocks = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--lock') {
    if (!args[i + 1]) throw new Error('--lock requires a path');
    requestedLocks.push(args[++i]);
  }
}
const lockPaths = requestedLocks.length ? requestedLocks : DEFAULT_RELEASE_LOCKS;
for (const lockPath of lockPaths) {
  if (!existsSync(lockPath)) throw new Error(`release lockfile missing: ${lockPath}`);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeId = (value) => String(value).replace(/[^A-Za-z0-9.-]/g, '-');
const encodeSegment = (value) => encodeURIComponent(value).replace(/%2F/gi, '%252F');

function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash <= 1 || slash === name.length - 1) throw new Error(`invalid scoped npm package name: ${name}`);
    const scope = name.slice(1, slash);
    const packageName = name.slice(slash + 1);
    return `pkg:npm/%40${encodeSegment(scope)}/${encodeSegment(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeSegment(name)}@${encodeURIComponent(version)}`;
}

function npmNameFromLockPath(lockPath) {
  const match = lockPath.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u);
  if (!match) throw new Error(`cannot infer npm package name from lock path: ${lockPath}`);
  return match[1];
}

function parentPackagePath(lockPath) {
  return lockPath.replace(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/u, '').replace(/\/$/u, '');
}

function resolveDependencyPath(fromPath, dependencyName, packages) {
  let cursor = fromPath;
  while (true) {
    const candidate = `${cursor ? `${cursor}/` : ''}node_modules/${dependencyName}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    if (!cursor) return null;
    const parent = parentPackagePath(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function packageId(componentKey, lockPath, name, version) {
  const location = lockPath || '<root>';
  const suffix = sha256(Buffer.from(`${componentKey}\0${location}`, 'utf8')).slice(0, 12);
  return `SPDXRef-Package-${safeId(componentKey)}-${safeId(name)}-${safeId(version)}-${suffix}`;
}

const packages = [];
const relationships = [];
const documentDescribes = [];
const lockReceipts = [];

for (const lockPath of lockPaths) {
  const lockBytes = readFileSync(lockPath);
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error(`unsupported npm lockfile format: ${lockPath}`);
  }
  const root = lock.packages[''];
  if (!root || typeof root.name !== 'string' || typeof root.version !== 'string') {
    throw new Error(`release lockfile root identity missing: ${lockPath}`);
  }
  const componentKey = `${root.name}@${root.version}`;
  const ids = new Map();

  for (const [packagePath, meta] of Object.entries(lock.packages)) {
    if (packagePath !== '' && !packagePath.includes('node_modules/')) continue;
    if (!meta || typeof meta.version !== 'string') {
      if (packagePath === '') throw new Error(`release root version missing: ${lockPath}`);
      continue;
    }
    const name = packagePath === '' ? root.name : (typeof meta.name === 'string' ? meta.name : npmNameFromLockPath(packagePath));
    const id = packageId(componentKey, packagePath, name, meta.version);
    ids.set(packagePath, id);
    const pkg = {
      SPDXID: id,
      name,
      versionInfo: meta.version,
      downloadLocation: meta.resolved ?? 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: meta.license ?? 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: npmPurl(name, meta.version),
      }],
      comment: `lockfile=${lockPath}; path=${packagePath || '<root>'}`,
    };
    if (typeof meta.integrity === 'string' && meta.integrity.startsWith('sha512-')) {
      pkg.checksums = [{ algorithm: 'SHA512', checksumValue: Buffer.from(meta.integrity.slice(7), 'base64').toString('hex') }];
    }
    packages.push(pkg);
  }

  const rootId = ids.get('');
  if (!rootId) throw new Error(`release root SPDX identity missing: ${lockPath}`);
  documentDescribes.push(rootId);

  for (const [packagePath, meta] of Object.entries(lock.packages)) {
    const fromId = ids.get(packagePath);
    if (!fromId || !meta) continue;
    const dependencyNames = new Set([
      ...Object.keys(meta.dependencies ?? {}),
      ...Object.keys(meta.optionalDependencies ?? {}),
      ...(packagePath === '' ? Object.keys(meta.devDependencies ?? {}) : []),
    ]);
    for (const dependencyName of [...dependencyNames].sort()) {
      const targetPath = resolveDependencyPath(packagePath, dependencyName, lock.packages);
      if (!targetPath) {
        throw new Error(`unresolved locked dependency: ${lockPath}:${packagePath || '<root>'} -> ${dependencyName}`);
      }
      const targetId = ids.get(targetPath);
      if (!targetId) {
        throw new Error(`dependency target lacks SPDX identity: ${lockPath}:${targetPath}`);
      }
      relationships.push({ spdxElementId: fromId, relationshipType: 'DEPENDS_ON', relatedSpdxElement: targetId });
    }
  }

  lockReceipts.push({ path: lockPath, sha256: sha256(lockBytes), packageCount: ids.size });
}

packages.sort((a, b) => a.SPDXID.localeCompare(b.SPDXID));
relationships.sort((a, b) => `${a.spdxElementId}\0${a.relatedSpdxElement}`.localeCompare(`${b.spdxElementId}\0${b.relatedSpdxElement}`));
documentDescribes.sort();
lockReceipts.sort((a, b) => a.path.localeCompare(b.path));

const bundleBinding = sha256(Buffer.from(lockReceipts.map((r) => `${r.path}\0${r.sha256}\0${r.packageCount}`).join('\n'), 'utf8'));
const doc = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `quarangate-release-npm-sbom-${bundleBinding.slice(0, 12)}`,
  documentNamespace: `https://quarangate.local/spdx/${bundleBinding}`,
  creationInfo: { created: '1970-01-01T00:00:00Z', creators: ['Tool: QuaranGate deterministic release-sbom.mjs'] },
  documentDescribes,
  packages,
  relationships,
  annotations: [{
    annotationDate: '1970-01-01T00:00:00Z',
    annotationType: 'OTHER',
    annotator: 'Tool: QuaranGate release-sbom.mjs',
    comment: `release lock binding sha256:${bundleBinding}; ${lockReceipts.map((r) => `${r.path}=sha256:${r.sha256};packages=${r.packageCount}`).join('; ')}`,
  }],
};
const rendered = `${JSON.stringify(doc, null, 2)}\n`;
if (output) writeFileSync(resolve(output), rendered); else process.stdout.write(rendered);
