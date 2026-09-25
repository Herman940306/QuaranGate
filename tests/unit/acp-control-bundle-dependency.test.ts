import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function sharedRuntimeImports(driverSource: string): string[] {
  const deps = new Set<string>();

  for (const match of driverSource.matchAll(
    /from ['"]\.\.\/\.\.\/shared\/([^'"]+\.js)['"]/g,
  )) {
    deps.add(`shared/${match[1]}`);
  }

  return [...deps].sort();
}

function bundledSharedFiles(backendSource: string): string[] {
  const deps = new Set<string>();

  for (const match of backendSource.matchAll(
    /name:\s*['"](shared\/[^'"]+\.js)['"]/g,
  )) {
    deps.add(match[1]);
  }

  return [...deps].sort();
}

describe('ACP control-volume runtime dependency closure', () => {
  const driver = read('src/executor/agents/acpDriver.ts');
  const required = sharedRuntimeImports(driver);

  it('detects the AcpDriver shared runtime dependency set', () => {
    expect(required).toContain('shared/errors.js');
    expect(required).toContain('shared/agents.js');
  });

  it('Kiro ships every shared runtime dependency imported by AcpDriver', () => {
    const backend = read('src/executor/agents/kiroBackend.ts');
    const bundled = bundledSharedFiles(backend);

    for (const dependency of required) {
      expect(
        bundled,
        `Kiro control bundle missing ${dependency}`,
      ).toContain(dependency);
    }
  });

  it('Copilot ships every shared runtime dependency imported by AcpDriver', () => {
    const backend = read('src/executor/agents/copilotBackend.ts');
    const bundled = bundledSharedFiles(backend);

    for (const dependency of required) {
      expect(
        bundled,
        `Copilot control bundle missing ${dependency}`,
      ).toContain(dependency);
    }
  });
});
