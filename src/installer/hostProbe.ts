import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostFacts } from './productInstaller.js';

export interface ProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HostProbeDependencies {
  platform: NodeJS.Platform;
  release: string;
  env: Readonly<Record<string, string | undefined>>;
  cpuCores: number;
  memoryBytes: number;
  storageBytesFree: number;
  installRoot: string;
  installRootIsSymlink: boolean;
  caseSensitive: boolean;
  supportsAtomicRename: boolean;
  readText(file: string): string;
  run(program: string, args: string[]): ProbeResult;
  /** Optional observation hook used only by deterministic tests. */
  calls?: Array<{ program: string; args: string[] }>;
}

function command(program: string, args: string[]): ProbeResult {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  return {
    exitCode: typeof result.status === 'number' ? result.status : 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function nearestExisting(input: string): string {
  let current = path.resolve(input);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No existing ancestor for installation root');
    current = parent;
  }
  return current;
}

function pathHasSymlink(input: string): boolean {
  const absolute = path.resolve(input);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function filesystemFacts(installRoot: string): {
  storageBytesFree: number;
  installRootIsSymlink: boolean;
  caseSensitive: boolean;
  supportsAtomicRename: boolean;
} {
  const existing = nearestExisting(path.dirname(path.resolve(installRoot)));
  const stat = statfsSync(existing, { bigint: true });
  const temp = mkdtempSync(path.join(existing, '.quarangate-readiness-'));
  let caseSensitive = false;
  let supportsAtomicRename = false;
  try {
    const source = path.join(temp, 'CaseProbe');
    const destination = path.join(temp, 'RenamedProbe');
    writeFileSync(source, 'probe', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    caseSensitive = !existsSync(path.join(temp, 'caseprobe'));
    renameSync(source, destination);
    supportsAtomicRename = readFileSync(destination, 'utf8') === 'probe' && !existsSync(source);
  } finally {
    rmSync(temp, { recursive: true, force: false });
  }
  return {
    storageBytesFree: Number(stat.bavail * stat.bsize),
    installRootIsSymlink: pathHasSymlink(installRoot),
    caseSensitive,
    supportsAtomicRename,
  };
}

export function defaultHostProbeDependencies(installRoot: string): HostProbeDependencies {
  const fsFacts = filesystemFacts(installRoot);
  return {
    platform: process.platform,
    release: os.release(),
    env: { WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME },
    cpuCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    storageBytesFree: fsFacts.storageBytesFree,
    installRoot,
    installRootIsSymlink: fsFacts.installRootIsSymlink,
    caseSensitive: fsFacts.caseSensitive,
    supportsAtomicRename: fsFacts.supportsAtomicRename,
    readText(file) {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    },
    run: command,
  };
}

function firstVersion(text: string): string | undefined {
  return text.match(/v?(\d+(?:\.\d+){1,3})/u)?.[1];
}

function run(deps: HostProbeDependencies, program: string, args: string[]): ProbeResult {
  return deps.run(program, args);
}

function detectPlatform(deps: HostProbeDependencies): Pick<HostFacts, 'platform' | 'wslDistribution' | 'wslVersion'> {
  if (deps.platform === 'win32') {
    return {
      platform: 'windows',
      ...(deps.env.WSL_DISTRO_NAME ? { wslDistribution: deps.env.WSL_DISTRO_NAME } : {}),
    };
  }
  if (deps.platform === 'darwin') return { platform: 'macos' };
  if (deps.platform !== 'linux') return { platform: 'unknown' };
  const kernel = `${deps.release}\n${deps.readText('/proc/version')}`;
  if (/microsoft|wsl/u.test(kernel.toLowerCase())) {
    const version: 1 | 2 = /wsl2|microsoft-standard/u.test(kernel.toLowerCase()) ? 2 : 1;
    return {
      platform: 'wsl',
      wslVersion: version,
      ...(deps.env.WSL_DISTRO_NAME ? { wslDistribution: deps.env.WSL_DISTRO_NAME } : {}),
    };
  }
  return { platform: 'linux' };
}

export function probeHostFacts(deps: HostProbeDependencies): HostFacts {
  const dockerVersion = run(deps, 'docker', ['--version']);
  const dockerInfo = run(deps, 'docker', ['info', '--format', '{{.ServerVersion}}']);
  const composeVersion = run(deps, 'docker', ['compose', 'version', '--short']);
  const gitVersion = run(deps, 'git', ['--version']);
  const nodeVersion = run(deps, 'node', ['--version']);
  const gpu = run(deps, 'nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits',
  ]);

  const platform = detectPlatform(deps);
  const dockerAvailable = dockerVersion.exitCode === 0;
  const dockerServerVersion = dockerInfo.exitCode === 0 ? firstVersion(dockerInfo.stdout) : undefined;
  const dockerClientVersion = firstVersion(dockerVersion.stdout);
  const gpuLine = gpu.exitCode === 0 ? gpu.stdout.trim().split(/\r?\n/u)[0] : undefined;
  const gpuParts = gpuLine?.split(',').map((part) => part.trim());
  const vramMib = gpuParts?.[1] ? Number(gpuParts[1]) : Number.NaN;

  return {
    ...platform,
    platformVersion: deps.release,
    docker: dockerAvailable
      ? {
          available: true,
          ...(dockerServerVersion ?? dockerClientVersion ? { version: dockerServerVersion ?? dockerClientVersion } : {}),
          daemonReachable: dockerInfo.exitCode === 0,
        }
      : { available: false },
    compose: composeVersion.exitCode === 0
      ? { available: true, ...(firstVersion(composeVersion.stdout) ? { version: firstVersion(composeVersion.stdout) } : {}) }
      : { available: false },
    git: gitVersion.exitCode === 0
      ? { available: true, ...(firstVersion(gitVersion.stdout) ? { version: firstVersion(gitVersion.stdout) } : {}) }
      : { available: false },
    node: nodeVersion.exitCode === 0
      ? { available: true, ...(firstVersion(nodeVersion.stdout) ? { version: firstVersion(nodeVersion.stdout) } : {}) }
      : { available: false },
    cpuCores: deps.cpuCores,
    memoryBytes: deps.memoryBytes,
    storageBytesFree: deps.storageBytesFree,
    filesystem: {
      supportsAtomicRename: deps.supportsAtomicRename,
      caseSensitive: deps.caseSensitive,
      installRootIsSymlink: deps.installRootIsSymlink,
    },
    gpu: gpuParts?.[0] && Number.isFinite(vramMib)
      ? { present: true, name: gpuParts[0], vramBytes: vramMib * 1024 * 1024 }
      : { present: false },
  };
}
