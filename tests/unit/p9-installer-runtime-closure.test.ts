import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_INSTALLER_RUNTIME_MODULES,
  PRODUCTION_INSTALLER_RUNTIME_PACKAGES,
  PRODUCTION_REQUIRED_PAYLOAD_FILES,
} from '../../src/installer/productionRelease.js';

const root = path.resolve(import.meta.dirname, '../..');

function resolveLocalImport(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = specifier.endsWith('.js')
    ? [base.slice(0, -3) + '.ts', base]
    : [base + '.ts', base + '.js', path.join(base, 'index.ts'), path.join(base, 'index.js')];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) throw new Error(`Unresolved installer runtime import: ${specifier} from ${fromFile}`);
  return resolved;
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function installerRuntimeGraph(): { sourceFiles: string[]; externalPackages: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string): void => {
    const absolute = path.resolve(file);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const source = readFileSync(absolute, 'utf8');
    expect(source).not.toMatch(/\bimport\s*\((?!\s*['"])/u);
    expect(source).not.toMatch(/\brequire\s*\(/u);
    const specifiers = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
      ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/gu),
    ].map((match) => match[1]!);
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        visit(resolveLocalImport(absolute, specifier));
      } else {
        external.add(packageName(specifier));
      }
    }
  };
  visit(path.join(root, 'src/installer/cli.ts'));
  return {
    sourceFiles: [...seen].map((file) => path.relative(root, file).split(path.sep).join('/')).sort(),
    externalPackages: [...external].sort(),
  };
}

describe('P9 production installer runtime closure', () => {
  it('keeps every transitive local CLI import manifest-bound', () => {
    const graph = installerRuntimeGraph();
    const compiled = graph.sourceFiles.map((file) => {
      if (!file.startsWith('src/') || !file.endsWith('.ts')) throw new Error(`Unexpected installer source path: ${file}`);
      return 'dist/' + file.slice('src/'.length, -'.ts'.length) + '.js';
    }).sort();

    expect(compiled).toEqual([...PRODUCTION_INSTALLER_RUNTIME_MODULES].sort());
    for (const relative of compiled) expect(PRODUCTION_REQUIRED_PAYLOAD_FILES).toContain(relative);
  });

  it('admits only the audited yaml and zod package dependencies', () => {
    const graph = installerRuntimeGraph();
    expect(graph.externalPackages).toEqual([...PRODUCTION_INSTALLER_RUNTIME_PACKAGES].sort());
  });

  it('pins the audited runtime package versions to the exact lockfile', () => {
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    for (const packageName of PRODUCTION_INSTALLER_RUNTIME_PACKAGES) {
      const locked = lock.packages[`node_modules/${packageName}`]?.version;
      const installed = JSON.parse(readFileSync(path.join(root, 'node_modules', packageName, 'package.json'), 'utf8')) as {
        version?: string;
      };
      expect(locked).toMatch(/^\d+\.\d+\.\d+/u);
      expect(installed.version).toBe(locked);
      expect(PRODUCTION_REQUIRED_PAYLOAD_FILES).toContain(`node_modules/${packageName}/package.json`);
    }
  });

  it('loads the real CLI from an isolated runtime tree containing only the audited production packages', () => {
    const graph = installerRuntimeGraph();
    const isolated = mkdtempSync(path.join(os.tmpdir(), 'qg-p9-runtime-closure-'));
    try {
      writeFileSync(path.join(isolated, 'package.json'), '{"type":"module"}\n');

      for (const sourceFile of graph.sourceFiles) {
        if (!sourceFile.startsWith('src/') || !sourceFile.endsWith('.ts')) {
          throw new Error(`Unexpected installer source path: ${sourceFile}`);
        }
        const source = readFileSync(path.join(root, sourceFile), 'utf8');
        const relativeOutput = 'dist/' + sourceFile.slice('src/'.length, -'.ts'.length) + '.js';
        const output = path.join(isolated, ...relativeOutput.split('/'));
        mkdirSync(path.dirname(output), { recursive: true });
        const transpiled = ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022,
          },
          fileName: sourceFile,
        }).outputText;
        writeFileSync(output, transpiled);
      }

      for (const packageName of PRODUCTION_INSTALLER_RUNTIME_PACKAGES) {
        cpSync(
          path.join(root, 'node_modules', packageName),
          path.join(isolated, 'node_modules', packageName),
          { recursive: true },
        );
      }

      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      const result = spawnSync(process.execPath, [path.join(isolated, 'dist', 'installer', 'cli.js')], {
        cwd: isolated,
        encoding: 'utf8',
        env,
        timeout: 30_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/INSTALLER_BLOCKED: usage: cli\.js/u);
      expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/u);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
