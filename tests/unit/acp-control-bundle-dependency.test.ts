import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import { extract as tarExtract } from 'tar-stream';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  buildAcpControlTar,
} from '../../src/executor/agents/acpControlAssets.js';

const root = process.cwd();

function runtimeModuleSpecifiers(source: string): string[] {
  const sf = ts.createSourceFile(
    'acpDriver.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const specs = new Set<string>();

  const add = (value: string): void => {
    specs.add(value);
  };

  const hasRuntimeImportBinding = (
    node: ts.ImportDeclaration,
  ): boolean => {
    if (!node.importClause) return true;
    if (node.importClause.isTypeOnly) return false;
    if (node.importClause.name) return true;

    const bindings = node.importClause.namedBindings;

    if (!bindings) return true;
    if (ts.isNamespaceImport(bindings)) return true;

    return bindings.elements.some((element) => !element.isTypeOnly);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && hasRuntimeImportBinding(node)
    ) {
      add(node.moduleSpecifier.text);
    }

    if (
      ts.isExportDeclaration(node)
      && !node.isTypeOnly
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    }

    if (
      ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text);
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;

      const isRequire =
        ts.isIdentifier(node.expression)
        && node.expression.text === 'require';

      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];

        if (!arg || !ts.isStringLiteralLike(arg)) {
          throw new Error(
            'ACP dependency closure cannot statically resolve a non-literal runtime module load',
          );
        }

        add(arg.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  return [...specs].sort();
}

function sharedRuntimeImports(source: string): string[] {
  return runtimeModuleSpecifiers(source)
    .filter((specifier) => specifier.startsWith('../../shared/'))
    .map((specifier) => {
      const rel = specifier.slice('../../'.length);

      if (!rel.endsWith('.js')) {
        throw new Error(
          `ACP shared runtime dependency must name a .js asset: ${specifier}`,
        );
      }

      return rel;
    })
    .sort();
}

function productionBuilderCallCount(
  source: string,
): number {
  const sf = ts.createSourceFile(
    'backend.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let count = 0;

  const visitProvisionControl = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'buildAcpControlTar'
    ) {
      count += 1;
    }

    ts.forEachChild(node, visitProvisionControl);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'provisionControl'
      && node.body
    ) {
      visitProvisionControl(node.body);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  return count;
}

async function unpackTar(
  tar: Buffer,
): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const extract = tarExtract();
    const files = new Map<string, Buffer>();

    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk));
      });

      stream.on('error', reject);

      stream.on('end', () => {
        if (header.type === 'file') {
          files.set(header.name, Buffer.concat(chunks));
        }
        next();
      });
    });

    extract.on('finish', () => resolve(files));
    extract.on('error', reject);

    Readable.from([tar]).pipe(extract);
  });
}

describe('ACP control-volume runtime dependency closure', () => {
  it('AST discovery covers multiline, side-effect, dynamic and require runtime loads', () => {
    const sample = `
      import {
        alpha
      } from '../../shared/multiline.js';

      import '../../shared/side-effect.js';

      async function load() {
        await import('../../shared/dynamic.js');
      }

      const required = require('../../shared/required.js');

      import type { TypeOnly } from '../../shared/type-only.js';
      import { type AlsoTypeOnly } from '../../shared/named-type-only.js';
    `;

    expect(sharedRuntimeImports(sample)).toEqual([
      'shared/dynamic.js',
      'shared/multiline.js',
      'shared/required.js',
      'shared/side-effect.js',
    ]);
  });

  it('fails closed when a runtime module load cannot be statically resolved', () => {
    expect(() => runtimeModuleSpecifiers(`
      const moduleName = '../../shared/runtime.js';
      void import(moduleName);
    `)).toThrow(/cannot statically resolve/);
  });

  it('derives the current AcpDriver shared runtime dependency set from its AST', () => {
    const source = readFileSync(
      join(root, 'src/executor/agents/acpDriver.ts'),
      'utf8',
    );

    expect(sharedRuntimeImports(source)).toEqual([
      'shared/agents.js',
      'shared/errors.js',
    ]);
  });

  it('both production backends build control archives through the shared builder', () => {
    const kiro = readFileSync(
      join(root, 'src/executor/agents/kiroBackend.ts'),
      'utf8',
    );

    const copilot = readFileSync(
      join(root, 'src/executor/agents/copilotBackend.ts'),
      'utf8',
    );

    expect(productionBuilderCallCount(kiro)).toBe(1);
    expect(productionBuilderCallCount(copilot)).toBe(1);
  });

  it('the actual production tar contains every required shared asset with exact trusted bytes', async () => {
    const source = readFileSync(
      join(root, 'src/executor/agents/acpDriver.ts'),
      'utf8',
    );

    const required = sharedRuntimeImports(source);

    const temp = mkdtempSync(
      join(tmpdir(), 'qg-acp-control-assets-'),
    );

    try {
      const dist = join(temp, 'dist');
      const agentDir = join(dist, 'executor', 'agents');

      mkdirSync(agentDir, { recursive: true });
      mkdirSync(join(dist, 'shared'), { recursive: true });

      writeFileSync(
        join(agentDir, 'runnerMain.js'),
        Buffer.from('RUNNER_MAIN_SENTINEL'),
      );

      writeFileSync(
        join(agentDir, 'acpDriver.js'),
        Buffer.from('ACP_DRIVER_SENTINEL'),
      );

      const expected = new Map<string, Buffer>();

      for (const dependency of required) {
        const content = Buffer.from(
          `TRUSTED_ASSET:${dependency}`,
          'utf8',
        );

        const target = join(dist, dependency);

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
        expected.set(dependency, content);
      }

      const tar = await buildAcpControlTar({
        driverAssetsDir: agentDir,
        runnerMainFile: 'runnerMain.js',
        control: { dryRun: true },
      });

      const files = await unpackTar(tar);

      expect(
        files.get('executor/agents/acpDriver.js'),
      ).toEqual(Buffer.from('ACP_DRIVER_SENTINEL'));

      for (const dependency of required) {
        expect(
          files.has(dependency),
          `control tar missing ${dependency}`,
        ).toBe(true);

        expect(
          files.get(dependency),
          `control tar has wrong bytes for ${dependency}`,
        ).toEqual(expected.get(dependency));
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
