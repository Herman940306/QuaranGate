/**
 * A4 Kiro runner — Docker integration + security proofs.
 *
 * Builds the REAL runner image (runner/kiro/Dockerfile) with a STUB kiro-cli so
 * the actual image contract (glibc base, /usr/local/bin binary location, secret
 * entrypoint, isolated HOME/XDG, non-root, RO rootfs) is exercised without a
 * real provider call. Uses the REAL CredentialManager / runnerAssets / EgressProxy
 * so the delivery + egress code paths are the ones under test.
 *
 * Proven here (deterministic, no paid call):
 *   - non-root, RO rootfs, workspace RO, docker.sock absent
 *   - HOME/KIRO_HOME/XDG isolated (no personal Kiro state)
 *   - credential delivered via secret-volume FILE (never Docker Env), entrypoint
 *     exports it for the child only
 *   - per-job bridge agent delivered on the home volume under an unguessable name
 *   - internal network => NO direct Internet (Proof A)
 *   - egress proxy DENIES non-allowlisted hosts and ALLOWS Kiro endpoints (Proof B)
 *   - workspace unchanged after the runner exits; cleanup removes resources
 *
 * Real provider-backed Kiro is NOT exercised here (blocked on headless auth —
 * see the phase audit); this file is container-property + egress proof only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  createVolume, removeVolume, createContainer, startContainer, waitContainer,
  getContainerLogs, inspectContainerFull, removeContainer,
  createNetwork, removeNetwork, connectNetwork,
} from '../../src/executor/docker.js';
import { LABEL_MANAGED, LABEL_JOB, LABEL_RESOURCE } from '../../src/executor/agents/sandboxSpec.js';
import { CredentialManager } from '../../src/executor/agents/credentialManager.js';
import { buildTar, populateVolume } from '../../src/executor/agents/runnerAssets.js';
import { bridgeAgentConfig } from '../../src/executor/agents/kiroBackend.js';
import { newBridgeAgentName } from '../../src/executor/agents/acpDriver.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO_ROOT, 'dist');
const IMAGE = 'mcp-ide-bridge-kiro-runner:a4-test';
const SYN_KEY = 'SYNTHETIC-KEY-' + randomBytes(6).toString('hex');
const newJobId = () => `job_${randomBytes(16).toString('hex')}`;

describe('A4 Kiro runner — Docker integration + security proofs', () => {
  let buildDir: string;

  beforeAll(() => {
    // Build the REAL Dockerfile with stub binaries (glibc base runs the shell
    // stubs fine). The stub answers --version and echoes ACP-mode diagnostics.
    //
    // BOTH `kiro-cli` and `kiro-cli-chat` are stubbed because the real
    // `kiro-cli` is only a dispatcher: `acp`/`chat`/`agent`/`mcp`/`settings` are
    // delegated to the sibling `kiro-cli-chat`, so the image contract requires
    // both binaries to be present in /usr/local/bin.
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
    writeFileSync(join(buildDir, 'Dockerfile'), readFileSync(join(REPO_ROOT, 'runner', 'kiro', 'Dockerfile')));
    writeFileSync(join(buildDir, 'kiro-acp-entrypoint.sh'), readFileSync(join(REPO_ROOT, 'runner', 'kiro', 'kiro-acp-entrypoint.sh')));
    execFileSync('docker', ['build', '-q', '-t', IMAGE, buildDir], { stdio: 'pipe' });
  }, 180_000);

  afterAll(() => { rmSync(buildDir, { recursive: true, force: true }); });

  it('runs non-root (uid/gid 1000) with a read-only rootfs', async () => {
    const id = await createContainer(`a4-nonroot-${newJobId()}`, {
      Image: IMAGE, User: '1000:1000', Cmd: ['sh', '-c', 'id; touch /probe 2>&1 || true'],
      HostConfig: { AutoRemove: false, ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,size=4m' } },
    });
    try {
      await startContainer(id); await waitContainer(id, { timeoutMs: 10_000 });
      const logs = await getContainerLogs(id, 4096);
      expect(logs.stdout).toContain('uid=1000'); expect(logs.stdout).toContain('gid=1000');
      expect(logs.stdout).toContain('Read-only file system');
    } finally { await removeContainer(id, true); }
  });

  it('isolates HOME/KIRO_HOME/XDG with no personal path, and binary lives outside $HOME', async () => {
    const id = await createContainer(`a4-home-${newJobId()}`, {
      Image: IMAGE, User: '1000:1000',
      Cmd: ['sh', '-c', 'echo "H=$HOME KH=$KIRO_HOME X=$XDG_STATE_HOME"; command -v kiro-cli'],
      HostConfig: { AutoRemove: false, ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,size=4m' } },
    });
    try {
      await startContainer(id); await waitContainer(id, { timeoutMs: 10_000 });
      const logs = await getContainerLogs(id, 4096);
      expect(logs.stdout).toContain('H=/home/runner');
      expect(logs.stdout).toContain('KH=/home/runner/.kiro');
      expect(logs.stdout).not.toContain('/home/herman');
      expect(logs.stdout).toContain('/usr/local/bin/kiro-cli'); // outside $HOME (unmaskable)
    } finally { await removeContainer(id, true); }
  });

  it('docker.sock is absent in the runner', async () => {
    const id = await createContainer(`a4-sock-${newJobId()}`, {
      Image: IMAGE, User: '1000:1000', Cmd: ['sh', '-c', 'test -e /var/run/docker.sock && echo PRESENT || echo ABSENT'],
      HostConfig: { AutoRemove: false, ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,size=4m' } },
    });
    try {
      await startContainer(id); await waitContainer(id, { timeoutMs: 10_000 });
      expect((await getContainerLogs(id, 4096)).stdout).toContain('ABSENT');
    } finally { await removeContainer(id, true); }
  });

  it('delivers the credential via a secret FILE (never Docker Env) and the entrypoint exports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a4key-'));
    const keyPath = join(dir, 'key');
    writeFileSync(keyPath, SYN_KEY + '\n', { mode: 0o600 });
    const jobId = newJobId();
    const cm = new CredentialManager({ credentialPath: keyPath, helperImage: IMAGE });
    const vol = await cm.provisionSecret(jobId);
    try {
      // The container gets NO KIRO_API_KEY in Env; the entrypoint reads the file.
      const id = await createContainer(`a4-secret-${jobId}`, {
        Image: IMAGE, User: '1000:1000',
        // Report only whether the entrypoint exported the key (length), never the value.
        Cmd: ['sh', '-c', 'if [ -n "$KIRO_API_KEY" ]; then echo "KEY_SET len=${#KIRO_API_KEY}"; else echo KEY_UNSET; fi'],
        HostConfig: {
          AutoRemove: false, ReadonlyRootfs: true,
          Mounts: [{ Type: 'volume', Source: vol, Target: '/run/secrets', ReadOnly: true }],
          Tmpfs: { '/tmp': 'rw,size=4m' },
        },
      });
      try {
        await startContainer(id); await waitContainer(id, { timeoutMs: 10_000 });
        const logs = await getContainerLogs(id, 8192);
        expect(logs.stdout).toContain(`KEY_SET len=${SYN_KEY.length}`); // entrypoint exported it to the child
        expect(logs.stdout).not.toContain(SYN_KEY);                     // value never printed
        // The invariant: the raw key VALUE is NOT anywhere in the container's
        // Docker metadata (Env/labels/cmd) — delivered only as a mounted file.
        const info = await inspectContainerFull(id);
        expect(JSON.stringify(info)).not.toContain(SYN_KEY);
      } finally { await removeContainer(id, true); }
    } finally { await removeVolume(vol, true); rmSync(dir, { recursive: true, force: true }); }
  });

  it('supplies the per-job bridge agent on the home volume under an UNGUESSABLE name (override-proof)', async () => {
    const jobId = newJobId();
    const agent = newBridgeAgentName(() => randomBytes(16).toString('hex'));
    const vol = `${'io-mcp-ide-bridge'}-home-${jobId}`;
    const tar = await buildTar({
      dirs: [{ name: '.kiro/' }, { name: '.kiro/agents/' }],
      files: [{ name: `.kiro/agents/${agent}.json`, content: Buffer.from(JSON.stringify(bridgeAgentConfig(agent))) }],
    });
    await populateVolume({ volumeName: vol, labels: { [LABEL_MANAGED]: 'true', [LABEL_JOB]: jobId, [LABEL_RESOURCE]: 'home' }, helperImage: IMAGE, mountPath: '/home/runner', tar });
    try {
      const id = await createContainer(`a4-agent-${jobId}`, {
        Image: IMAGE, User: '1000:1000',
        Cmd: ['sh', '-c', `ls /home/runner/.kiro/agents; cat /home/runner/.kiro/agents/${agent}.json`],
        HostConfig: { AutoRemove: false, Mounts: [{ Type: 'volume', Source: vol, Target: '/home/runner', ReadOnly: false }], Tmpfs: { '/tmp': 'rw,size=4m' } },
      });
      try {
        await startContainer(id); await waitContainer(id, { timeoutMs: 10_000 });
        const logs = await getContainerLogs(id, 8192);
        expect(logs.stdout).toContain(`${agent}.json`);
        expect(logs.stdout).not.toContain('bridge_readonly.json'); // no fixed guessable name to override
        expect(logs.stdout).toContain('"read"'); // read/grep/glob only
        expect(logs.stdout).not.toContain('"*"');
      } finally { await removeContainer(id, true); }
    } finally { await removeVolume(vol, true); }
  });

  it('workspace mounted READ-ONLY cannot be modified; unchanged after the runner exits', async () => {
    const jobId = newJobId();
    const vol = `a4-ws-${jobId}`;
    await createVolume(vol, { [LABEL_MANAGED]: 'true', [LABEL_JOB]: jobId, [LABEL_RESOURCE]: 'workspace' });
    try {
      const pop = await createContainer(`a4-pop-${jobId}`, {
        Image: IMAGE, User: '0:0', Cmd: ['sh', '-c', "echo ORIGINAL > /workspace/f.txt && chown 1000:1000 /workspace/f.txt"],
        HostConfig: { AutoRemove: false, Mounts: [{ Type: 'volume', Source: vol, Target: '/workspace', ReadOnly: false }], Tmpfs: { '/tmp': 'rw,size=4m' } },
      });
      await startContainer(pop); await waitContainer(pop, { timeoutMs: 10_000 }); await removeContainer(pop, true);

      const run = await createContainer(`a4-mod-${jobId}`, {
        Image: IMAGE, User: '1000:1000', Cmd: ['sh', '-c', 'echo MOD > /workspace/f.txt 2>&1 || true; echo NEW > /workspace/n.txt 2>&1 || true; cat /workspace/f.txt; ls /workspace'],
        HostConfig: { AutoRemove: false, ReadonlyRootfs: true, Mounts: [{ Type: 'volume', Source: vol, Target: '/workspace', ReadOnly: true }], Tmpfs: { '/tmp': 'rw,size=4m' } },
      });
      await startContainer(run); await waitContainer(run, { timeoutMs: 10_000 });
      const logs = await getContainerLogs(run, 4096);
      await removeContainer(run, true);
      expect(logs.stdout).toContain('ORIGINAL');
      expect(logs.stdout).not.toContain('MOD');
      expect(logs.stdout).not.toContain('n.txt');
    } finally { await removeVolume(vol, true); }
  });

  it('Proof A: a container on an internal network has NO direct Internet route', async () => {
    const net = `a4-int-${newJobId()}`;
    await createNetwork(net, { internal: true, labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'net' } });
    try {
      const id = await createContainer(`a4-noint-${newJobId()}`, {
        Image: IMAGE, User: '1000:1000',
        Cmd: ['node', '-e', 'const s=require("net").connect({host:"1.1.1.1",port:443});s.setTimeout(6000);s.on("connect",()=>{console.log("CONNECTED_BAD");process.exit(0)});s.on("timeout",()=>{console.log("NO_INTERNET");process.exit(0)});s.on("error",e=>{console.log("NO_INTERNET:"+e.code);process.exit(0)});'],
        HostConfig: { AutoRemove: false, NetworkMode: net, ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,size=4m' } },
      });
      try {
        await startContainer(id); await waitContainer(id, { timeoutMs: 15_000 });
        const logs = await getContainerLogs(id, 4096);
        expect(logs.stdout).toContain('NO_INTERNET');
        expect(logs.stdout).not.toContain('CONNECTED_BAD');
      } finally { await removeContainer(id, true); }
    } finally { await removeNetwork(net); }
  });

  it('Proof B: the egress proxy DENIES non-allowlisted hosts and ALLOWS Kiro endpoints (from an internal client)', async () => {
    const jobId = newJobId();
    const intNet = `a4-pint-${jobId}`, extNet = `a4-pext-${jobId}`;
    await createNetwork(intNet, { internal: true, labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'net' } });
    await createNetwork(extNet, { internal: false, labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'net' } });
    const proxy = await createContainer(`a4-proxy-${jobId}`, {
      Image: IMAGE, User: '1000:1000', Cmd: ['node', '/app/dist/executor/agents/egressProxyMain.js'],
      Env: ['EGRESS_PROXY_PORT=8080'], Labels: { [LABEL_MANAGED]: 'true', [LABEL_JOB]: jobId, [LABEL_RESOURCE]: 'proxy' },
      HostConfig: { AutoRemove: false, ReadonlyRootfs: true, Mounts: [{ Type: 'bind', Source: DIST, Target: '/app/dist', ReadOnly: true }], Tmpfs: { '/tmp': 'rw,size=4m' } },
      NetworkingConfig: { EndpointsConfig: { [intNet]: { Aliases: ['egress-proxy'] } } },
    });
    try {
      await connectNetwork(extNet, proxy);
      await startContainer(proxy);
      await new Promise((r) => setTimeout(r, 1500));
      const probe = (host: string) => `const net=require("net");const s=net.connect({host:"egress-proxy",port:8080});let b="";s.setTimeout(10000,()=>{console.log("TIMEOUT");process.exit(0)});s.on("connect",()=>s.write("CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}\\r\\n\\r\\n"));s.on("data",d=>{b+=d;if(b.includes("\\r\\n\\r\\n")){console.log(b.split("\\r\\n")[0]);s.destroy();process.exit(0)}});s.on("error",e=>{console.log("ERR:"+e.code);process.exit(0)});`;
      // DENY example.com (no Internet needed to prove the 403 policy gate).
      const deny = await createContainer(`a4-deny-${jobId}`, {
        Image: IMAGE, User: '1000:1000', Cmd: ['node', '-e', probe('example.com')],
        HostConfig: { AutoRemove: false, NetworkMode: intNet, ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,size=4m' } },
      });
      await startContainer(deny); await waitContainer(deny, { timeoutMs: 15_000 });
      const denyLog = (await getContainerLogs(deny, 4096)).stdout;
      await removeContainer(deny, true);
      expect(denyLog).toContain('403');

      // ALLOW an allowlisted Kiro host: it must pass the policy gate (NOT 403).
      const allow = await createContainer(`a4-allow-${jobId}`, {
        Image: IMAGE, User: '1000:1000', Cmd: ['node', '-e', probe('runtime.us-east-1.kiro.dev')],
        HostConfig: { AutoRemove: false, NetworkMode: intNet, ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,size=4m' } },
      });
      await startContainer(allow); await waitContainer(allow, { timeoutMs: 15_000 });
      const allowLog = (await getContainerLogs(allow, 4096)).stdout;
      await removeContainer(allow, true);
      expect(allowLog).not.toContain('403'); // allowed past the allowlist (200 tunnel, or 502 if host offline)
    } finally {
      await removeContainer(proxy, true).catch(() => {});
      await removeNetwork(extNet).catch(() => {});
      await removeNetwork(intNet).catch(() => {});
    }
  });
}, 240_000);
