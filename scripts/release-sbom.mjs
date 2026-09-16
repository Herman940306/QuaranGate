#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const outAt = args.indexOf('--output');
const output = outAt >= 0 ? args[outAt + 1] : undefined;
const lockBytes = readFileSync('package-lock.json');
const lock = JSON.parse(lockBytes.toString('utf8'));
const root = lock.packages?.[''] ?? {};
const rootName = root.name ?? lock.name ?? 'quarangate';
const rootVersion = root.version ?? lock.version ?? '0.0.0';
const safe = (s) => String(s).replace(/[^A-Za-z0-9.-]/g, '-');
const rootId = `SPDXRef-Package-${safe(rootName)}`;
const packages = [];
const relationships = [];
for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  if (!path.startsWith('node_modules/') || !meta?.version) continue;
  const name = meta.name ?? path.slice('node_modules/'.length);
  const id = `SPDXRef-Package-${safe(name)}-${safe(meta.version)}-${createHash('sha256').update(path).digest('hex').slice(0,12)}`;
  const pkg = {
    SPDXID: id,
    name,
    versionInfo: meta.version,
    downloadLocation: meta.resolved ?? 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: meta.license ?? 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(meta.version)}` }],
  };
  if (typeof meta.integrity === 'string' && meta.integrity.startsWith('sha512-')) {
    pkg.checksums = [{ algorithm: 'SHA512', checksumValue: Buffer.from(meta.integrity.slice(7), 'base64').toString('hex') }];
  }
  packages.push(pkg);
  relationships.push({ spdxElementId: rootId, relationshipType: 'DEPENDS_ON', relatedSpdxElement: id });
}
packages.sort((a,b) => a.SPDXID.localeCompare(b.SPDXID));
relationships.sort((a,b) => a.relatedSpdxElement.localeCompare(b.relatedSpdxElement));
const lockSha = createHash('sha256').update(lockBytes).digest('hex');
const doc = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `${rootName}-${rootVersion}-npm-sbom`,
  documentNamespace: `https://quarangate.local/spdx/${lockSha}`,
  creationInfo: { created: '1970-01-01T00:00:00Z', creators: ['Tool: QuaranGate deterministic release-sbom.mjs'] },
  packages: [{ SPDXID: rootId, name: rootName, versionInfo: rootVersion, downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: root.license ?? 'NOASSERTION', copyrightText: 'NOASSERTION' }, ...packages],
  relationships,
  annotations: [{ annotationDate: '1970-01-01T00:00:00Z', annotationType: 'OTHER', annotator: 'Tool: QuaranGate release-sbom.mjs', comment: `package-lock.json sha256:${lockSha}` }],
};
const rendered = `${JSON.stringify(doc, null, 2)}\n`;
if (output) writeFileSync(resolve(output), rendered); else process.stdout.write(rendered);
