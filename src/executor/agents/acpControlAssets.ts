/**
 * Shared production construction of runner-internal ACP control archives.
 *
 * Both Kiro and Copilot execute the same AcpDriver inside their runner
 * containers. Keeping its runtime asset set here prevents the two backends from
 * silently drifting apart when AcpDriver gains another runtime dependency.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildTar, type TarFile } from './runnerAssets.js';

export interface AcpControlTarOptions {
  driverAssetsDir: string;
  runnerMainFile: string;
  control: object;
  extraFiles?: TarFile[];
}

/**
 * Return the files required by the shared AcpDriver runtime.
 *
 * The independent regression test derives AcpDriver's shared runtime imports
 * from its TypeScript AST and verifies the actual generated tar contains these
 * files with the exact bytes read from the trusted compiled asset directory.
 */
export function acpDriverRuntimeFiles(driverAssetsDir: string): TarFile[] {
  return [
    {
      name: 'executor/agents/acpDriver.js',
      content: readFileSync(join(driverAssetsDir, 'acpDriver.js')),
      mode: 0o500,
    },
    {
      name: 'shared/errors.js',
      content: readFileSync(
        join(driverAssetsDir, '..', '..', 'shared', 'errors.js'),
      ),
      mode: 0o500,
    },
    {
      name: 'shared/agents.js',
      content: readFileSync(
        join(driverAssetsDir, '..', '..', 'shared', 'agents.js'),
      ),
      mode: 0o500,
    },
  ];
}

/** Build the exact control tar consumed by production ACP runners. */
export async function buildAcpControlTar(
  opts: AcpControlTarOptions,
): Promise<Buffer> {
  return buildTar({
    dirs: [
      { name: 'executor/', mode: 0o700 },
      { name: 'executor/agents/', mode: 0o700 },
      { name: 'shared/', mode: 0o700 },
    ],
    files: [
      {
        name: `executor/agents/${opts.runnerMainFile}`,
        content: readFileSync(
          join(opts.driverAssetsDir, opts.runnerMainFile),
        ),
        mode: 0o500,
      },
      ...acpDriverRuntimeFiles(opts.driverAssetsDir),
      {
        name: 'control.json',
        content: Buffer.from(JSON.stringify(opts.control), 'utf8'),
        mode: 0o400,
      },
      ...(opts.extraFiles ?? []),
    ],
  });
}
