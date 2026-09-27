import { afterEach, describe, expect, it } from 'vitest';
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ASSESSMENT_STAGER_SCRIPT,
  BE9_SOURCE_STAGING_POLICY_VERSION,
} from '../../src/shared/securityAssessmentStaging.js';

const ASSESSMENT_ID = `assessment_${'a'.repeat(24)}`;
const PROJECT_ID = 'project-a';
const STAGER_IMAGE_ID = `sha256:${'b'.repeat(64)}`;

const roots: string[] = [];

interface Fixture {
  root: string;
  src: string;
  staged: string;
  revision: string;
}

interface Receipt {
  schemaVersion: string;
  mode: 'stage' | 'verify';
  assessmentId: string;
  projectId: string;
  sourceRevision: string;
  sourceTree: string;
  fileCount: number;
  totalBytes: number;
  manifestBytes: number;
  manifestDigest: string;
  stagerImageId: string;
  stagingPolicyVersion: string;
  createdAt: string;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'be9-stage-proof-'));
  roots.push(root);
  const src = join(root, 'src');
  const staged = join(root, 'workspace');
  mkdirSync(src);
  mkdirSync(staged);
  git(src, 'init', '--quiet');
  git(src, 'config', 'user.email', 'be9-test@example.invalid');
  git(src, 'config', 'user.name', 'BE9 Test');
  mkdirSync(join(src, 'nested'));
  writeFileSync(join(src, 'alpha.txt'), 'alpha\n');
  writeFileSync(join(src, 'nested', 'beta.txt'), 'beta\n');
  git(src, 'add', '--all');
  git(src, 'commit', '--quiet', '-m', 'fixture');
  return {
    root,
    src,
    staged,
    revision: git(src, 'rev-parse', 'HEAD'),
  };
}

function scriptFor(input: Fixture): string {
  return ASSESSMENT_STAGER_SCRIPT
    .replace("const SRC = '/src';", `const SRC = ${JSON.stringify(input.src)};`)
    .replace("const DST = '/workspace';", `const DST = ${JSON.stringify(input.staged)};`);
}

function run(
  input: Fixture,
  mode: 'stage' | 'verify',
  expectedManifestDigest = '',
) {
  return spawnSync(process.execPath, ['-e', scriptFor(input)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPECTED_SOURCE_REVISION: input.revision,
      EXPECTED_MANIFEST_DIGEST: expectedManifestDigest,
      ASSESSMENT_STAGE_MODE: mode,
      ASSESSMENT_ID,
      PROJECT_ID,
      STAGER_IMAGE_ID,
      STAGING_POLICY_VERSION: BE9_SOURCE_STAGING_POLICY_VERSION,
    },
  });
}

function receipt(result: ReturnType<typeof run>): Receipt {
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.split('\n').filter((line) => line.startsWith('BE9_STAGE_RECEIPT='));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!.slice('BE9_STAGE_RECEIPT='.length)) as Receipt;
}

function stage(input: Fixture): Receipt {
  return receipt(run(input, 'stage'));
}

function expectRejected(result: ReturnType<typeof run>, pattern: RegExp): void {
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(pattern);
}

describe('BE9.2 exact staged-volume proof', () => {
  it('re-walks the existing staged volume and reproduces the frozen manifest without restaging', () => {
    const input = fixture();
    const frozen = stage(input);
    const alphaBefore = readFileSync(join(input.staged, 'alpha.txt'), 'utf8');

    const verified = receipt(run(input, 'verify', frozen.manifestDigest));

    expect(verified).toMatchObject({
      mode: 'verify',
      assessmentId: ASSESSMENT_ID,
      projectId: PROJECT_ID,
      sourceRevision: input.revision,
      sourceTree: frozen.sourceTree,
      fileCount: frozen.fileCount,
      totalBytes: frozen.totalBytes,
      manifestBytes: frozen.manifestBytes,
      manifestDigest: frozen.manifestDigest,
      stagerImageId: STAGER_IMAGE_ID,
      stagingPolicyVersion: BE9_SOURCE_STAGING_POLICY_VERSION,
    });
    expect(readFileSync(join(input.staged, 'alpha.txt'), 'utf8')).toBe(alphaBefore);
  });

  it('denies changed staged bytes even when host Git source remains unchanged', () => {
    const input = fixture();
    const frozen = stage(input);
    writeFileSync(join(input.staged, 'alpha.txt'), 'tampered-but-same-host\n');

    expectRejected(
      run(input, 'verify', frozen.manifestDigest),
      /unexpected staged|staged (?:accounting|size|blob)|staged manifest drift/,
    );
    expect(git(input.src, 'status', '--porcelain=v1')).toBe('');
    expect(git(input.src, 'rev-parse', 'HEAD')).toBe(input.revision);
  });

  it('denies host source revision drift even when staged bytes remain unchanged', () => {
    const input = fixture();
    const frozen = stage(input);
    writeFileSync(join(input.src, 'new.txt'), 'new source\n');
    git(input.src, 'add', '--all');
    git(input.src, 'commit', '--quiet', '-m', 'drift');

    expectRejected(run(input, 'verify', frozen.manifestDigest), /source revision drift/);
    expect(readFileSync(join(input.staged, 'alpha.txt'), 'utf8')).toBe('alpha\n');
  });

  it('denies an unexpected staged file', () => {
    const input = fixture();
    const frozen = stage(input);
    writeFileSync(join(input.staged, 'injected.txt'), 'unexpected\n');

    expectRejected(run(input, 'verify', frozen.manifestDigest), /unexpected staged file/);
  });

  it('denies a missing staged file', () => {
    const input = fixture();
    const frozen = stage(input);
    unlinkSync(join(input.staged, 'nested', 'beta.txt'));

    expectRejected(run(input, 'verify', frozen.manifestDigest), /staged accounting|missing staged file/);
  });

  it('denies a staged symlink', () => {
    const input = fixture();
    const frozen = stage(input);
    symlinkSync('alpha.txt', join(input.staged, 'link.txt'));

    expectRejected(run(input, 'verify', frozen.manifestDigest), /unexpected staged symlink/);
  });

  it('denies a staged hardlink', () => {
    const input = fixture();
    const frozen = stage(input);
    linkSync(join(input.staged, 'alpha.txt'), join(input.staged, 'hard.txt'));

    expectRejected(run(input, 'verify', frozen.manifestDigest), /unexpected hardlink|unexpected staged file/);
  });
});
