import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_IMAGE, assertNoRegistryActivity, ociLayoutBuildContext, renderOfflineDockerfile, validateOciLayout } from '../../scripts/offline-local-base.mjs';
import { coreBuildPlan } from '../../scripts/p10-offline-core-build.mjs';

describe('P10 local-only core build', () => {
  it('requires exact absolute source/bundle paths and source commit', () => {
    expect(() => coreBuildPlan([])).toThrow(/source-root/u);
    expect(() => coreBuildPlan(['--source-root', 'relative', '--source-commit', 'a'.repeat(40), '--bundle', '/tmp/b', '--output-image', 'qg:test'])).toThrow(/source-root must be absolute/u);
    expect(() => coreBuildPlan(['--source-root', '/tmp/s', '--source-commit', 'bad', '--bundle', '/tmp/b', '--output-image', 'qg:test'])).toThrow(/40 lowercase hex/u);
  });

  it('validates and addresses a local OCI image layout by exact digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'qg-p10-oci-test-'));
    try {
      const layout = join(root, 'layout');
      const blobs = join(layout, 'blobs', 'sha256');
      mkdirSync(blobs, { recursive: true });
      const blob = Buffer.from('{"schemaVersion":2}', 'utf8');
      const hex = createHash('sha256').update(blob).digest('hex');
      writeFileSync(join(layout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n');
      writeFileSync(join(blobs, hex), blob);
      writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${hex}`, size: blob.length }] }));
      const validated = validateOciLayout(layout);
      expect(validated.digest).toBe(`sha256:${hex}`);
      expect(ociLayoutBuildContext('p10_node_base', validated)).toBe(`p10_node_base=oci-layout://${layout}@sha256:${hex}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates an offline-only Dockerfile from the exact reviewed pinned bases', () => {
    const source = `FROM ${BASE_IMAGE} AS build\nRUN echo build\nFROM ${BASE_IMAGE} AS runtime\nUSER node\n`;
    const rendered = renderOfflineDockerfile(source);
    expect(rendered).toContain('FROM p10_node_base AS build');
    expect(rendered).toContain('FROM p10_node_base AS runtime');
    expect(rendered).not.toContain(`FROM ${BASE_IMAGE}`);
    expect(() => renderOfflineDockerfile('FROM alpine:3.20 AS build\n')).toThrow(/pinned base contract drifted/u);
  });

  it('fails closed on BuildKit registry metadata or auth activity', () => {
    for (const sample of [
      '[auth] library/node:pull token for registry-1.docker.io',
      'load metadata for docker.io/library/node:24-alpine',
      'resolve docker.io/library/node:24-alpine',
    ]) expect(() => assertNoRegistryActivity(sample)).toThrow(/registry metadata\/auth activity/u);
    expect(() => assertNoRegistryActivity('load build context p10_node_base from local OCI layout')).not.toThrow();
  });

  it('exports the immutable local base to OCI layout and keeps build RUN networking disabled', () => {
    const helper = readFileSync(new URL('../../scripts/offline-local-base.mjs', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../../scripts/p10-offline-core-build.mjs', import.meta.url), 'utf8');
    expect(helper).toContain("'image', 'save', '--output', archive, imageId");
    expect(helper).toContain("'tar', ['--no-same-owner', '-xf', archive, '-C', layoutDir]");
    expect(helper).toContain('oci-layout://${layout.layoutDir}@${layout.digest}');
    expect(source).toContain("'--network=none', '--pull=false', '--no-cache'");
    expect(source).toContain("'--file', offlineDockerfile");
    expect(source).toContain("ociLayoutBuildContext('p10_node_base', localBase)");
    expect(source).toContain('assertNoRegistryActivity(combined)');
    expect(source).toContain('cleanupLocalOciLayout(localBase)');
  });
});
