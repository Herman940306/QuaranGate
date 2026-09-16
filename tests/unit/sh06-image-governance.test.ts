import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const SHA256_REF = /@sha256:[0-9a-f]{64}$/u;
const dockerfiles = [
  'Dockerfile',
  'assistant-environment-review-target/Dockerfile',
  'assistant-environment-work-target/Dockerfile',
  'review-target/Dockerfile',
  'runner/Dockerfile',
  'runner/kiro/Dockerfile',
  'test-target/Dockerfile',
] as const;

function fromRefs(file: string): string[] {
  return readFileSync(join(root, file), 'utf8').split(/\r?\n/u)
    .map((line) => /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/iu.exec(line)?.[1])
    .filter((value): value is string => Boolean(value));
}

function compose(file: string): any {
  return YAML.parse(readFileSync(join(root, file), 'utf8'));
}

describe('SH-06 immutable image/base governance', () => {
  it('digest-pins every external Dockerfile base image', () => {
    for (const file of dockerfiles) {
      const aliases = new Set<string>();
      for (const line of readFileSync(join(root, file), 'utf8').split(/\r?\n/u)) {
        const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/iu.exec(line);
        if (!match) continue;
        const image = match[1]!;
        if (!aliases.has(image)) expect(image, `${file}: ${line}`).toMatch(SHA256_REF);
        if (match[2]) aliases.add(match[2]);
      }
    }
  });

  it('pins the reviewed exact base identities rather than arbitrary digests', () => {
    expect(fromRefs('Dockerfile')).toEqual([
      'node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81',
      'node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81',
    ]);
    expect(fromRefs('runner/kiro/Dockerfile')).toEqual([
      'node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553',
    ]);
    expect(fromRefs('test-target/Dockerfile')).toEqual([
      'alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc',
    ]);
  });

  it('requires explicit primary service images and disables runtime pulls', () => {
    const primary = compose('compose.yaml');
    expect(primary.services.gateway).toMatchObject({
      image: '${GATEWAY_IMAGE:?set immutable QuaranGate gateway image}', pull_policy: 'never',
    });
    expect(primary.services['docker-authority']).toMatchObject({
      image: '${DOCKER_AUTHORITY_IMAGE:?set immutable QuaranGate Docker-authority image}', pull_policy: 'never',
    });
    expect(primary.services.executor).toMatchObject({
      image: '${EXECUTOR_IMAGE:?set immutable QuaranGate executor image}', pull_policy: 'never',
    });
    expect(readFileSync(join(root, 'compose.yaml'), 'utf8')).not.toContain('quarangate:latest');
  });

  it('requires pull-never on optional production services and a digest-only Ollama image', () => {
    const github = compose('compose.github.yaml');
    expect(github.services['github-broker'].pull_policy).toBe('never');
    expect(github.services['github-egress-proxy'].pull_policy).toBe('never');
    const ollama = compose('compose.ollama.yaml');
    expect(ollama.services.ollama.image).toContain('@sha256 required');
    expect(ollama.services.ollama.pull_policy).toBe('never');
  });

  it('makes the invariant gate reject a newly introduced tag-only Dockerfile base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-sh06-'));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'src', 'gateway'), { recursive: true });
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:24-alpine\nUSER node\n');
    writeFileSync(join(dir, 'src', 'gateway', 'x.ts'), 'export {};\n');
    writeFileSync(join(dir, 'compose.yaml'), 'services:\n  gateway:\n    image: x\n  executor:\n    image: x\n  docker-authority:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n');
    const result = spawnSync(process.execPath, [join(root, 'scripts/security-invariants.mjs'), '--root', dir], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('IMMUTABLE_DOCKERFILE_BASE');
  });

  it('binds owner deployment and unattended recovery to persisted immutable image IDs', () => {
    const deploy = readFileSync(join(root, 'scripts/remote-owner-deploy-candidate.sh'), 'utf8');
    const start = readFileSync(join(root, 'scripts/remote-owner-start.sh'), 'utf8');
    for (const key of [
      'GATEWAY_IMAGE_ID', 'DOCKER_AUTHORITY_IMAGE_ID', 'EXECUTOR_IMAGE_ID',
    ]) {
      expect(deploy).toContain(key);
      expect(start).toContain(key);
    }
    expect(deploy).toContain('gateway/docker-authority/executor shared-artifact identity mismatch');
    expect(deploy).toContain('persisted image tag was retargeted before deployment commit');
    expect(start).toContain('runtime image tag-to-ID binding mismatch');
    expect(start).toContain('live image identity mismatch');
    expect(start).toContain('OLLAMA_IMAGE must be digest-pinned with @sha256');
    expect(start).not.toMatch(/docker\s+(?:pull|build)\b/u);
  });

  it('documents all six primary image identity keys without real credentials', () => {
    const env = readFileSync(join(root, '.env.example'), 'utf8');
    for (const key of [
      'GATEWAY_IMAGE', 'GATEWAY_IMAGE_ID', 'DOCKER_AUTHORITY_IMAGE',
      'DOCKER_AUTHORITY_IMAGE_ID', 'EXECUTOR_IMAGE', 'EXECUTOR_IMAGE_ID',
    ]) expect(env).toContain(`${key}=`);
    expect(env).toContain('OLLAMA_IMAGE=<repository>@sha256:<64-lowercase-hex>');
  });
});
