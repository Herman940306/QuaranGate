import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseMaterialPlan, relativeRuntimeImports, sourcePayloadFile } from '../../scripts/p9-production-release-material.mjs';

const commit = 'a'.repeat(40);

describe('P9 production release material builder', () => {
  it('requires exact absolute source/output roots, exact source commit and canonical release time', () => {
    expect(() => releaseMaterialPlan([])).toThrow(/--source-root is required/u);
    expect(() => releaseMaterialPlan([
      '--source-root', 'relative',
      '--source-commit', commit,
      '--core-image', 'quarangate:core',
      '--projects-work-seed-image', 'assistant-environment-work:latest',
      '--output-root', '/tmp/release',
      '--created-at', '2026-09-18T15:00:00.000Z',
    ])).toThrow(/source-root must be absolute/u);
    expect(() => releaseMaterialPlan([
      '--source-root', '/workspace/source',
      '--source-commit', 'bad',
      '--core-image', 'quarangate:core',
      '--projects-work-seed-image', 'assistant-environment-work:latest',
      '--output-root', '/tmp/release',
      '--created-at', '2026-09-18T15:00:00.000Z',
    ])).toThrow(/40 lowercase hex/u);
    expect(() => releaseMaterialPlan([
      '--source-root', '/workspace/source',
      '--source-commit', commit,
      '--core-image', 'quarangate:core',
      '--projects-work-seed-image', 'assistant-environment-work:latest',
      '--output-root', '/workspace/source/release',
      '--created-at', '2026-09-18T15:00:00.000Z',
    ])).toThrow(/outside the source worktree/u);
    expect(() => releaseMaterialPlan([
      '--source-root', '/workspace/source',
      '--source-commit', commit,
      '--core-image', 'quarangate:core',
      '--projects-work-seed-image', 'assistant-environment-work:latest',
      '--output-root', '/tmp/release',
      '--created-at', '2026-09-18T15:00:00Z',
    ])).toThrow(/canonical UTC ISO/u);
  });

  it('derives exact immutable component-specific release references from the source commit', () => {
    const plan = releaseMaterialPlan([
      '--source-root', '/workspace/source',
      '--source-commit', commit,
      '--core-image', 'quarangate:p10-core-a',
      '--projects-work-seed-image', 'assistant-environment-work:latest',
      '--output-root', '/tmp/release',
      '--created-at', '2026-09-18T15:00:00.000Z',
    ]);
    expect(plan.imageReferences).toEqual({
      'docker-authority': `quarangate:docker-authority-${commit}`,
      executor: `quarangate:executor-${commit}`,
      gateway: `quarangate:gateway-${commit}`,
      'projects-work': `quarangate:projects-work-${commit}`,
    });
  });

  it('keeps all build/probe operations local-only and never manufactures signing authority', () => {
    const source = readFileSync(new URL('../../scripts/p9-production-release-material.mjs', import.meta.url), 'utf8');
    expect(source).toContain("'--pull=never', '--network', 'none'");
    expect(source).toContain("'DEFERRED_EXTERNAL_OWNER_CREDENTIAL'");
    expect(source).toContain("detachedEd25519SignatureProof: 'NOT_CREATED'");
    expect(source).toContain("installerTrustPolicy: 'NOT_CREATED'");
    expect(source).toContain("signedWindowsPackage: 'NOT_CREATED'");
    expect(source).not.toMatch(/generateKeyPair|privateKey|\bsign\s*\(/u);
    expect(source).not.toMatch(/\b(?:curl|wget)\b|https:\/\/registry\.npmjs\.org/u);
  });

  it('builds the payload from exact source files plus the audited core runtime closure only', () => {
    const source = readFileSync(new URL('../../scripts/p9-production-release-material.mjs', import.meta.url), 'utf8');
    expect(source).toContain('PRODUCTION_INSTALLER_RUNTIME_MODULES');
    expect(source).toContain('PRODUCTION_INSTALLER_RUNTIME_PACKAGES');
    expect(source).toContain("JSON.stringify(['yaml', 'zod'])");
    expect(source).toContain("production.verifyProductionReleaseProfile(manifest)");
    expect(source).toContain("production.verifyProductionReleasePayloadClosure(payloadRoot, manifest)");
    expect(source).toContain("releasePackage.verifyReleasePayload");
    expect(source).toContain("lstatSync(plan.sourceRoot).isSymbolicLink()");
    expect(source).toContain("stat.nlink !== 1");
  });

  it('recursively resolves only relative audited dist imports for the temporary release contract', () => {
    expect(relativeRuntimeImports(
      'dist/installer/releasePackage.js',
      "import { createHash } from 'node:crypto';\nimport { canonicalSerialize } from '../executor/agents/canonicalJson.js';\n",
    )).toEqual(['dist/executor/agents/canonicalJson.js']);
    expect(relativeRuntimeImports(
      'dist/executor/agents/canonicalJson.js',
      "import { BridgeError } from '../../shared/errors.js';\n",
    )).toEqual(['dist/shared/errors.js']);
    expect(() => relativeRuntimeImports(
      'dist/installer/releasePackage.js',
      "import yaml from 'yaml';\n",
    )).toThrow(/non-builtin external import/u);
    expect(() => relativeRuntimeImports(
      'dist/installer/releasePackage.js',
      "import x from '../../../escape.js';\n",
    )).toThrow(/escapes audited dist JavaScript/u);
  });

  it('rejects symlinked source payload parents instead of dereferencing them inside the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'qg-release-source-'));
    try {
      const real = join(root, 'real');
      mkdirSync(real);
      writeFileSync(join(real, 'payload.txt'), 'trusted');
      symlinkSync(real, join(root, 'alias'), 'dir');
      expect(() => sourcePayloadFile(root, 'alias/payload.txt')).toThrow(/symbolic-link component/u);
      expect(sourcePayloadFile(root, 'real/payload.txt')).toBe(join(real, 'payload.txt'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('qualifies the projects-work seed independently instead of relabelling the P10 fixture target', () => {
    const source = readFileSync(new URL('../../scripts/p9-production-release-material.mjs', import.meta.url), 'utf8');
    expect(source).toContain("projectsWorkSeedImage");
    expect(source).toContain("PROJECTS_WORK_SEED=PASS");
    expect(source).toContain("test ! -S /var/run/docker.sock");
    expect(source).not.toContain('mcp-bridge-testtarget');
  });
});
