/**
 * A4 Kiro runner — Docker integration + security proofs.
 *
 * Hardened-authority version:
 *   - every managed resource uses current io.quarangate ownership
 *   - every job id is canonical
 *   - every managed container uses an immutable local image ID
 *   - Docker-authority confinement fields are explicit
 *   - networks use the exact current job-derived names
 *   - proxy code is baked into a disposable test image; no host bind is used
 *
 * No paid provider call is made.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import {
  createVolume,
  removeVolume,
  createContainer,
  startContainer,
  waitContainer,
  getContainerLogs,
  inspectContainerFull,
  removeContainer,
  createNetwork,
  removeNetwork,
  connectNetwork,
  inspectImage,
} from '../../src/executor/docker.js';

import {
  SANDBOX_LABEL_NS,
  LABEL_MANAGED,
  LABEL_JOB,
  LABEL_RESOURCE,
  ownershipLabels,
} from '../../src/executor/agents/sandboxSpec.js';

import { CredentialManager } from '../../src/executor/agents/credentialManager.js';
import { buildTar, populateVolume } from '../../src/executor/agents/runnerAssets.js';
import { bridgeAgentConfig } from '../../src/executor/agents/kiroBackend.js';
import { newBridgeAgentName } from '../../src/executor/agents/acpDriver.js';
import { jobNetworkName } from '../../src/executor/agents/egressProxy.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const RUNNER_TAG = 'qg-itest-kiro-runner:a4-hardened';
const PROXY_TAG = 'qg-itest-egress-proxy:a4-hardened';

const NODE_PROXY_BASE =
  'node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81';

const SYN_KEY = 'SYNTHETIC-KEY-' + randomBytes(6).toString('hex');

const newJobId = (): string =>
  `job_${randomBytes(16).toString('hex')}`;

const ns = (): string =>
  SANDBOX_LABEL_NS.replace(/\./g, '-');

function labels(resource: string, jobId: string): Record<string, string> {
  return {
    [LABEL_MANAGED]: 'true',
    [LABEL_RESOURCE]: resource,
    [LABEL_JOB]: jobId,
  };
}

type VolumeMount = {
  Type: 'volume';
  Source: string;
  Target: string;
  ReadOnly: boolean;
};

let runnerImageId = '';
let proxyImageId = '';
let buildDir = '';
let proxyBuildDir = '';

function runnerBody(
  jobId: string,
  cmd: string[],
  opts: {
    user?: string;
    mounts?: VolumeMount[];
    networkMode?: string;
  } = {},
): Record<string, unknown> {
  return {
    Image: runnerImageId,
    User: opts.user ?? '1000:1000',
    Cmd: cmd,
    Labels: ownershipLabels('runner', jobId),
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: opts.networkMode ?? 'none',
      Mounts: opts.mounts ?? [],
      Tmpfs: {
        '/tmp': 'rw,nosuid,nodev,size=8m',
      },
      Memory: 268_435_456,
      MemorySwap: 268_435_456,
      PidsLimit: 64,
    },
  };
}

function proxyBody(
  jobId: string,
  internalNetwork: string,
): Record<string, unknown> {
  return {
    Image: proxyImageId,
    User: '1000:1000',
    Cmd: [
      'node',
      '/app/dist/executor/agents/egressProxyMain.js',
    ],
    Env: ['EGRESS_PROXY_PORT=8080'],
    Labels: labels('proxy', jobId),
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: internalNetwork,
      Mounts: [],
      Tmpfs: {
        '/tmp': 'rw,nosuid,nodev,size=8m',
      },
      Memory: 134_217_728,
      MemorySwap: 134_217_728,
      PidsLimit: 32,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [internalNetwork]: {
          Aliases: ['egress-proxy'],
        },
      },
    },
  };
}

async function waitForProxy(
  containerId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const logs = await getContainerLogs(containerId, 8192)
      .catch(() => ({ stdout: '' } as any));

    if (logs.stdout.includes('egress proxy listening')) return;

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('egress proxy did not become ready');
}

describe('A4 Kiro runner — Docker integration + security proofs', () => {
  beforeAll(async () => {
    buildDir = mkdtempSync(join(tmpdir(), 'a4b-'));

    const stub = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "kiro-cli-stub 2.5.0-test"; exit 0; fi',
      'if [ "$1" = "acp" ]; then',
      '  if [ "$2" = "--help" ]; then echo "stub acp help"; exit 0; fi',
      '  echo "KEY_SET=$(test -n \\"$KIRO_API_KEY\\" && echo yes || echo no)"',
      '  echo "HOME=$HOME KIRO_HOME=$KIRO_HOME"',
      '  echo "AGENTS=$(ls $KIRO_HOME/agents 2>/dev/null)"',
      '  echo "WS_WRITABLE=$(touch /workspace/.w 2>/dev/null && echo yes || echo no)"',
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n');

    writeFileSync(join(buildDir, 'kiro-cli'), stub, { mode: 0o755 });
    writeFileSync(join(buildDir, 'kiro-cli-chat'), stub, { mode: 0o755 });

    writeFileSync(
      join(buildDir, 'Dockerfile'),
      readFileSync(join(REPO_ROOT, 'runner', 'kiro', 'Dockerfile')),
    );

    writeFileSync(
      join(buildDir, 'kiro-acp-entrypoint.sh'),
      readFileSync(join(REPO_ROOT, 'runner', 'kiro', 'kiro-acp-entrypoint.sh')),
    );

    execFileSync(
      'docker',
      ['build', '--pull=false', '-q', '-t', RUNNER_TAG, buildDir],
      { stdio: 'pipe' },
    );

    runnerImageId = (await inspectImage(RUNNER_TAG)).Id;
    expect(runnerImageId).toMatch(/^sha256:[0-9a-f]{64}$/);

    proxyBuildDir = mkdtempSync(join(tmpdir(), 'a4proxy-'));

    writeFileSync(
      join(proxyBuildDir, 'Dockerfile'),
      [
        `FROM ${NODE_PROXY_BASE}`,
        'WORKDIR /app',
        'COPY dist /app/dist',
        'USER 1000:1000',
        '',
      ].join('\n'),
    );

    // The repository .dockerignore intentionally excludes dist. Stage the
    // already-built output into this disposable context so the proxy image
    // remains source-free and does not require a host bind.
    cpSync(join(REPO_ROOT, 'dist'), join(proxyBuildDir, 'dist'), { recursive: true });

    execFileSync(
      'docker',
      [
        'build',
        '--pull=false',
        '-q',
        '-t',
        PROXY_TAG,
        '-f',
        join(proxyBuildDir, 'Dockerfile'),
        proxyBuildDir,
      ],
      { stdio: 'pipe' },
    );

    proxyImageId = (await inspectImage(PROXY_TAG)).Id;
    expect(proxyImageId).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 180_000);

  afterAll(() => {
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
    if (proxyBuildDir) rmSync(proxyBuildDir, { recursive: true, force: true });
  });

  it('runs non-root with a read-only rootfs', async () => {
    const jobId = newJobId();

    const id = await createContainer(
      `a4-nonroot-${jobId}`,
      runnerBody(
        jobId,
        ['sh', '-c', 'id; touch /probe 2>&1 || true'],
      ),
    );

    try {
      await startContainer(id);
      await waitContainer(id, { timeoutMs: 10_000 });

      const logs = await getContainerLogs(id, 4096);

      expect(logs.stdout).toContain('uid=1000');
      expect(logs.stdout).toContain('gid=1000');
      expect(logs.stdout).toContain('Read-only file system');
    } finally {
      await removeContainer(id, true);
    }
  });

  it('isolates HOME/KIRO_HOME/XDG with no personal path and keeps the binary outside HOME', async () => {
    const jobId = newJobId();

    const id = await createContainer(
      `a4-home-${jobId}`,
      runnerBody(
        jobId,
        [
          'sh',
          '-c',
          'echo "H=$HOME KH=$KIRO_HOME X=$XDG_STATE_HOME"; command -v kiro-cli',
        ],
      ),
    );

    try {
      await startContainer(id);
      await waitContainer(id, { timeoutMs: 10_000 });

      const logs = await getContainerLogs(id, 4096);

      expect(logs.stdout).toContain('H=/home/runner');
      expect(logs.stdout).toContain('KH=/home/runner/.kiro');
      expect(logs.stdout).not.toContain('/home/herman');
      expect(logs.stdout).toContain('/usr/local/bin/kiro-cli');
    } finally {
      await removeContainer(id, true);
    }
  });

  it('docker.sock is absent in the runner', async () => {
    const jobId = newJobId();

    const id = await createContainer(
      `a4-sock-${jobId}`,
      runnerBody(
        jobId,
        [
          'sh',
          '-c',
          'test -e /var/run/docker.sock && echo PRESENT || echo ABSENT',
        ],
      ),
    );

    try {
      await startContainer(id);
      await waitContainer(id, { timeoutMs: 10_000 });

      expect(
        (await getContainerLogs(id, 4096)).stdout,
      ).toContain('ABSENT');
    } finally {
      await removeContainer(id, true);
    }
  });

  it('delivers the credential via a secret file and never Docker metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a4key-'));
    const keyPath = join(dir, 'key');

    writeFileSync(keyPath, SYN_KEY + '\n', { mode: 0o600 });

    const jobId = newJobId();

    const cm = new CredentialManager({
      credentialPath: keyPath,
      helperImage: runnerImageId,
    });

    const vol = await cm.provisionSecret(jobId);

    try {
      const id = await createContainer(
        `a4-secret-${jobId}`,
        runnerBody(
          jobId,
          [
            'sh',
            '-c',
            'if [ -n "$KIRO_API_KEY" ]; then echo "KEY_SET len=${#KIRO_API_KEY}"; else echo KEY_UNSET; fi',
          ],
          {
            mounts: [{
              Type: 'volume',
              Source: vol,
              Target: '/run/secrets',
              ReadOnly: true,
            }],
          },
        ),
      );

      try {
        await startContainer(id);
        await waitContainer(id, { timeoutMs: 10_000 });

        const logs = await getContainerLogs(id, 8192);

        expect(logs.stdout).toContain(`KEY_SET len=${SYN_KEY.length}`);
        expect(logs.stdout).not.toContain(SYN_KEY);

        const info = await inspectContainerFull(id);
        expect(JSON.stringify(info)).not.toContain(SYN_KEY);
      } finally {
        await removeContainer(id, true);
      }
    } finally {
      await removeVolume(vol, true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supplies the per-job bridge agent under an unguessable name', async () => {
    const jobId = newJobId();
    const agent = newBridgeAgentName(
      () => randomBytes(16).toString('hex'),
    );

    const vol = `${ns()}-home-${jobId}`;

    const tar = await buildTar({
      dirs: [
        { name: '.kiro/' },
        { name: '.kiro/agents/' },
      ],
      files: [{
        name: `.kiro/agents/${agent}.json`,
        content: Buffer.from(
          JSON.stringify(bridgeAgentConfig(agent)),
        ),
      }],
    });

    await populateVolume({
      volumeName: vol,
      labels: labels('home', jobId),
      helperImage: runnerImageId,
      mountPath: '/home/runner',
      tar,
    });

    try {
      const id = await createContainer(
        `a4-agent-${jobId}`,
        runnerBody(
          jobId,
          [
            'sh',
            '-c',
            `ls /home/runner/.kiro/agents; cat /home/runner/.kiro/agents/${agent}.json`,
          ],
          {
            mounts: [{
              Type: 'volume',
              Source: vol,
              Target: '/home/runner',
              ReadOnly: false,
            }],
          },
        ),
      );

      try {
        await startContainer(id);
        await waitContainer(id, { timeoutMs: 10_000 });

        const logs = await getContainerLogs(id, 8192);

        expect(logs.stdout).toContain(`${agent}.json`);
        expect(logs.stdout).not.toContain('bridge_readonly.json');
        expect(logs.stdout).toContain('"read"');
        expect(logs.stdout).not.toContain('"*"');
      } finally {
        await removeContainer(id, true);
      }
    } finally {
      await removeVolume(vol, true);
    }
  });

  it('workspace mounted read-only cannot be modified', async () => {
    const jobId = newJobId();
    const vol = `${ns()}-workspace-${jobId}`;

    await createVolume(
      vol,
      ownershipLabels('workspace', jobId),
    );

    try {
      const populate = await createContainer(
        `a4-pop-${jobId}`,
        runnerBody(
          jobId,
          [
            'sh',
            '-c',
            'printf "ORIGINAL\\n" > /workspace/f.txt',
          ],
          {
            user: '1000:1000',
            mounts: [{
              Type: 'volume',
              Source: vol,
              Target: '/workspace',
              ReadOnly: false,
            }],
          },
        ),
      );

      try {
        await startContainer(populate);

        const populated = await waitContainer(
          populate,
          { timeoutMs: 10_000 },
        );

        const populateLogs =
          await getContainerLogs(populate, 4096);

        expect(
          populated,
          `workspace population failed: ${JSON.stringify(populateLogs)}`,
        ).toEqual({
          statusCode: 0,
          timedOut: false,
        });

        expect(
          populateLogs.stderr,
          `workspace population stderr: ${populateLogs.stderr}`,
        ).toBe('');
      } finally {
        await removeContainer(populate, true);
      }

      const run = await createContainer(
        `a4-mod-${jobId}`,
        runnerBody(
          jobId,
          [
            'sh',
            '-c',
            'echo MOD > /workspace/f.txt 2>&1 || true; echo NEW > /workspace/n.txt 2>&1 || true; cat /workspace/f.txt; ls /workspace',
          ],
          {
            mounts: [{
              Type: 'volume',
              Source: vol,
              Target: '/workspace',
              ReadOnly: true,
            }],
          },
        ),
      );

      try {
        await startContainer(run);
        await waitContainer(run, { timeoutMs: 10_000 });

        const logs = await getContainerLogs(run, 4096);

        expect(logs.stdout).toContain('ORIGINAL');
        expect(logs.stdout).not.toContain('MOD');
        expect(logs.stdout).not.toContain('n.txt');
      } finally {
        await removeContainer(run, true);
      }
    } finally {
      await removeVolume(vol, true);
    }
  });

  it('Proof A: an internal-network runner has no direct Internet route', async () => {
    const jobId = newJobId();
    const net = jobNetworkName(jobId);

    await createNetwork(net, {
      internal: true,
      labels: labels('net', jobId),
    });

    try {
      const id = await createContainer(
        `a4-noint-${jobId}`,
        runnerBody(
          jobId,
          [
            'node',
            '-e',
            'const s=require("net").connect({host:"1.1.1.1",port:443});s.setTimeout(6000);s.on("connect",()=>{console.log("CONNECTED_BAD");process.exit(0)});s.on("timeout",()=>{console.log("NO_INTERNET");process.exit(0)});s.on("error",e=>{console.log("NO_INTERNET:"+e.code);process.exit(0)});',
          ],
          { networkMode: net },
        ),
      );

      try {
        await startContainer(id);
        await waitContainer(id, { timeoutMs: 15_000 });

        const logs = await getContainerLogs(id, 4096);

        expect(logs.stdout).toContain('NO_INTERNET');
        expect(logs.stdout).not.toContain('CONNECTED_BAD');
      } finally {
        await removeContainer(id, true);
      }
    } finally {
      await removeNetwork(net);
    }
  });

  it('Proof B: the proxy denies non-allowlisted hosts and permits Kiro endpoints past the policy gate', async () => {
    const jobId = newJobId();

    const intNet = jobNetworkName(jobId);
    const extNet = `${intNet}-ext`;

    const netLabels = labels('net', jobId);

    await createNetwork(intNet, {
      internal: true,
      labels: netLabels,
    });

    await createNetwork(extNet, {
      internal: false,
      labels: netLabels,
    });

    const proxy = await createContainer(
      `${ns()}-proxy-${jobId}`,
      proxyBody(jobId, intNet),
    );

    try {
      await connectNetwork(extNet, proxy);
      await startContainer(proxy);
      await waitForProxy(proxy);

      const probe = (host: string) =>
        `const net=require("net");const s=net.connect({host:"egress-proxy",port:8080});let b="";s.setTimeout(10000,()=>{console.log("TIMEOUT");process.exit(0)});s.on("connect",()=>s.write("CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}\\r\\n\\r\\n"));s.on("data",d=>{b+=d;if(b.includes("\\r\\n\\r\\n")){console.log(b.split("\\r\\n")[0]);s.destroy();process.exit(0)}});s.on("error",e=>{console.log("ERR:"+e.code);process.exit(0)});`;

      const deny = await createContainer(
        `a4-deny-${jobId}`,
        runnerBody(
          jobId,
          ['node', '-e', probe('example.com')],
          { networkMode: intNet },
        ),
      );

      await startContainer(deny);
      await waitContainer(deny, { timeoutMs: 15_000 });

      const denyLog =
        (await getContainerLogs(deny, 4096)).stdout;

      await removeContainer(deny, true);

      expect(denyLog).toContain('403');

      const allow = await createContainer(
        `a4-allow-${jobId}`,
        runnerBody(
          jobId,
          ['node', '-e', probe('runtime.us-east-1.kiro.dev')],
          { networkMode: intNet },
        ),
      );

      await startContainer(allow);
      await waitContainer(allow, { timeoutMs: 15_000 });

      const allowLog =
        (await getContainerLogs(allow, 4096)).stdout;

      await removeContainer(allow, true);

      expect(allowLog).not.toContain('403');
    } finally {
      await removeContainer(proxy, true).catch(() => {});
      await removeNetwork(extNet).catch(() => {});
      await removeNetwork(intNet).catch(() => {});
    }
  });
}, 240_000);
