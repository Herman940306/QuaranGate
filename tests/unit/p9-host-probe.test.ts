import { describe, expect, it } from 'vitest';
import { probeHostFacts, type HostProbeDependencies } from '../../src/installer/hostProbe.js';

const gib = 1024 ** 3;

function deps(overrides: Partial<HostProbeDependencies> = {}): HostProbeDependencies {
  const calls: Array<{ program: string; args: string[] }> = [];
  return {
    platform: 'linux',
    release: '6.6.87.2-microsoft-standard-WSL2',
    env: { WSL_DISTRO_NAME: 'Ubuntu-24.04', SECRET_TOKEN: 'must-not-leak' },
    cpuCores: 8,
    memoryBytes: 32 * gib,
    storageBytesFree: 200 * gib,
    installRoot: '/opt/quarangate',
    installRootIsSymlink: false,
    caseSensitive: true,
    supportsAtomicRename: true,
    readText: (file) => file === '/proc/version' ? 'Linux version microsoft-standard-WSL2' : '',
    run(program, args) {
      calls.push({ program, args });
      const key = [program, ...args].join(' ');
      if (key === 'docker --version') return { exitCode: 0, stdout: 'Docker version 29.7.2, build abc', stderr: '' };
      if (key === 'docker info --format {{.ServerVersion}}') return { exitCode: 0, stdout: '29.7.2', stderr: '' };
      if (key === 'docker compose version --short') return { exitCode: 0, stdout: '5.5.0', stderr: '' };
      if (key === 'git --version') return { exitCode: 0, stdout: 'git version 2.43.0', stderr: '' };
      if (key === 'node --version') return { exitCode: 0, stdout: 'v24.20.0', stderr: '' };
      if (program === 'nvidia-smi') return { exitCode: 0, stdout: 'Generic GPU, 12288', stderr: '' };
      return { exitCode: 127, stdout: '', stderr: 'not found' };
    },
    calls,
    ...overrides,
  };
}

describe('P9 D1 mechanical host probe', () => {
  it('detects WSL2, fixed tool versions, resources, storage, and GPU', () => {
    const input = deps();
    const facts = probeHostFacts(input);
    expect(facts).toMatchObject({
      platform: 'wsl',
      wslDistribution: 'Ubuntu-24.04',
      wslVersion: 2,
      cpuCores: 8,
      memoryBytes: 32 * gib,
      storageBytesFree: 200 * gib,
      docker: { available: true, version: '29.7.2', daemonReachable: true },
      compose: { available: true, version: '5.5.0' },
      git: { available: true, version: '2.43.0' },
      node: { available: true, version: '24.20.0' },
      gpu: { present: true, name: 'Generic GPU', vramBytes: 12288 * 1024 * 1024 },
    });
    expect(JSON.stringify(facts)).not.toContain('must-not-leak');
  });

  it('uses only fixed executables and argument arrays, never a shell command', () => {
    const input = deps();
    probeHostFacts(input);
    expect(input.calls.map((call) => call.program)).toEqual([
      'docker', 'docker', 'docker', 'git', 'node', 'nvidia-smi',
    ]);
    expect(input.calls.every((call) => !['sh', 'bash', 'cmd.exe', 'powershell.exe'].includes(call.program))).toBe(true);
  });

  it('classifies missing tools and an unreachable daemon without inventing versions', () => {
    const input = deps({
      run: () => ({ exitCode: 127, stdout: '', stderr: 'not found' }),
    });
    const facts = probeHostFacts(input);
    expect(facts.docker).toEqual({ available: false });
    expect(facts.compose).toEqual({ available: false });
    expect(facts.git).toEqual({ available: false });
    expect(facts.node).toEqual({ available: false });
    expect(facts.gpu).toEqual({ present: false });
  });

  it('does not classify generic Linux as WSL from an untrusted environment name alone', () => {
    const input = deps({
      release: '6.8.0-generic',
      readText: () => 'Linux version 6.8.0-generic',
    });
    expect(probeHostFacts(input).platform).toBe('linux');
  });
});
