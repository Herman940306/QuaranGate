/**
 * Minimal Docker Engine API client over the unix socket (undici).
 * Only the endpoints the executor needs are implemented — the executor's API
 * surface can never express arbitrary Docker calls.
 */
import { Pool } from 'undici';
import { PassThrough, Readable } from 'node:stream';
import { BridgeError } from '../shared/errors.js';

const SOCKET = process.env.DOCKER_SOCK ?? '/var/run/docker.sock';
// A Pool (multiple connections) — a long-lived streaming exec must not block
// concurrent control calls (e.g. the timeout-kill exec) on the same socket.
const client = new Pool('http://localhost', { socketPath: SOCKET, connections: 16 });

async function dockerJson<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const opts: Parameters<typeof client.request>[0] = { method, path };
  if (body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await client.request(opts).catch((e: Error) => {
    throw new BridgeError('DOCKER_UNAVAILABLE', `docker api unreachable: ${e.message}`, 503);
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new BridgeError('DOCKER_UNAVAILABLE', `docker api ${path} -> ${res.statusCode}: ${text.slice(0, 300)}`, 502);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels: Record<string, string>;
}

export async function listContainers(all = false): Promise<ContainerSummary[]> {
  return dockerJson<ContainerSummary[]>('GET', `/v1.44/containers/json?all=${all ? 1 : 0}`);
}

export async function inspectContainer(id: string): Promise<{ State: { Running: boolean; Status: string }; Config: { Image: string; Labels: Record<string, string> } }> {
  return dockerJson('GET', `/v1.44/containers/${encodeURIComponent(id)}/json`);
}

interface ExecCreateResponse { Id: string }
interface ExecInspect { ExitCode: number | null; Running: boolean; Pid: number }

export interface RawExecOptions {
  cmd: string[];
  workingDir?: string;
  env?: string[];
  user?: string;
}

export async function execCreate(containerId: string, opts: RawExecOptions): Promise<string> {
  const body: Record<string, unknown> = {
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: opts.cmd,
  };
  if (opts.workingDir) body.WorkingDir = opts.workingDir;
  if (opts.env) body.Env = opts.env;
  if (opts.user) body.User = opts.user;
  const r = await dockerJson<ExecCreateResponse>('POST', `/v1.44/containers/${encodeURIComponent(containerId)}/exec`, body);
  return r.Id;
}

export async function execInspect(execId: string): Promise<ExecInspect> {
  return dockerJson<ExecInspect>('GET', `/v1.44/exec/${encodeURIComponent(execId)}/json`);
}

/**
 * Start an exec and stream demultiplexed stdout/stderr.
 * Docker multiplexes with 8-byte frame headers: [type,0,0,0,len32be].
 */
export async function execStartStream(execId: string): Promise<{ stdout: PassThrough; stderr: PassThrough; done: Promise<void> }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const res = await client.request({
    method: 'POST',
    path: `/v1.44/exec/${encodeURIComponent(execId)}/start`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Detach: false, Tty: false }),
  });
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new BridgeError('DOCKER_UNAVAILABLE', `exec start failed: ${res.statusCode} ${text.slice(0, 200)}`, 502);
  }

  const done = (async () => {
    let buf = Buffer.alloc(0);
    for await (const chunk of res.body as Readable) {
      buf = Buffer.concat([buf, chunk as Buffer]);
      while (buf.length >= 8) {
        const type = buf[0];
        const len = buf.readUInt32BE(4);
        if (buf.length < 8 + len) break;
        const payload = buf.subarray(8, 8 + len);
        (type === 2 ? stderr : stdout).write(payload);
        buf = buf.subarray(8 + len);
      }
    }
    stdout.end();
    stderr.end();
  })();

  return { stdout, stderr, done };
}

/** GET a path from a container as a tar stream. */
export async function getArchive(containerId: string, absPath: string): Promise<{ body: Readable; statHeader: string | undefined }> {
  const res = await client.request({
    method: 'GET',
    path: `/v1.44/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(absPath)}`,
  });
  if (res.statusCode === 404) {
    await res.body.dump();
    throw new BridgeError('FILE_NOT_FOUND', `not found: ${absPath}`, 404);
  }
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new BridgeError('DOCKER_UNAVAILABLE', `archive get failed: ${res.statusCode} ${text.slice(0, 200)}`, 502);
  }
  const statHeader = res.headers['x-docker-container-path-stat'] as string | undefined;
  return { body: res.body as unknown as Readable, statHeader };
}

/** PUT a tar stream into a container directory. */
export async function putArchive(containerId: string, absDir: string, tarBuffer: Buffer): Promise<void> {
  const res = await client.request({
    method: 'PUT',
    path: `/v1.44/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(absDir)}&noOverwriteDirNonDir=1`,
    headers: { 'content-type': 'application/x-tar' },
    body: tarBuffer,
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new BridgeError('DOCKER_UNAVAILABLE', `archive put failed: ${res.statusCode} ${text.slice(0, 200)}`, 502);
  }
}

// ---------------------------------------------------------------------------
// A3 runner-sandbox lifecycle primitives.
//
// These are the ONLY additional Docker Engine capabilities the executor gained
// in A3, added strictly for the trusted internal runner sandbox. They are never
// exposed as executor HTTP routes and cannot be driven by an MCP caller: the
// request bodies are constructed exclusively from trusted policy in
// sandboxSpec.ts. Enumeration/removal is always scoped by a filter selector so
// callers cannot delete resources by name/age/image.
// ---------------------------------------------------------------------------

const API = '/v1.44';

/** URL-encode a Docker `filters` object, e.g. { label: ['k=v'] }. */
function filtersParam(filters: Record<string, string[]>): string {
  return `filters=${encodeURIComponent(JSON.stringify(filters))}`;
}

/** Demultiplex a Docker (Tty:false) stdout/stderr stream: [type,0,0,0,len32be]. */
function demuxDockerStream(buf: Buffer): { stdout: Buffer; stderr: Buffer } {
  let out = Buffer.alloc(0);
  let err = Buffer.alloc(0);
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + len;
    if (end > buf.length) break; // partial trailing frame
    const payload = buf.subarray(start, end);
    if (type === 2) err = Buffer.concat([err, payload]);
    else out = Buffer.concat([out, payload]);
    i = end;
  }
  return { stdout: out, stderr: err };
}

export async function inspectImage(ref: string): Promise<{ Id: string }> {
  return dockerJson('GET', `${API}/images/${encodeURIComponent(ref)}/json`);
}

export interface VolumeSummary { Name: string; Labels: Record<string, string> | null }

export async function createVolume(name: string, labels: Record<string, string>): Promise<void> {
  await dockerJson('POST', `${API}/volumes/create`, { Name: name, Driver: 'local', Labels: labels });
}

export async function removeVolume(name: string, force = true): Promise<void> {
  const res = await client.request({ method: 'DELETE', path: `${API}/volumes/${encodeURIComponent(name)}?force=${force ? 1 : 0}` });
  const text = await res.body.text();
  // 404 (already gone) is acceptable for idempotent cleanup.
  if (res.statusCode >= 400 && res.statusCode !== 404) {
    throw new BridgeError('DOCKER_UNAVAILABLE', `volume remove failed: ${res.statusCode} ${text.slice(0, 200)}`, 502);
  }
}

export async function listVolumesByFilter(filters: Record<string, string[]>): Promise<VolumeSummary[]> {
  const r = await dockerJson<{ Volumes: VolumeSummary[] | null }>('GET', `${API}/volumes?${filtersParam(filters)}`);
  return r.Volumes ?? [];
}

export async function listContainersByFilter(filters: Record<string, string[]>, all = true): Promise<ContainerSummary[]> {
  return dockerJson<ContainerSummary[]>('GET', `${API}/containers/json?all=${all ? 1 : 0}&${filtersParam(filters)}`);
}

/** Create a container from a fully-formed, trusted-policy body. */
export async function createContainer(name: string, body: Record<string, unknown>): Promise<string> {
  const r = await dockerJson<{ Id: string }>('POST', `${API}/containers/create?name=${encodeURIComponent(name)}`, body);
  return r.Id;
}

export async function startContainer(id: string): Promise<void> {
  const res = await client.request({ method: 'POST', path: `${API}/containers/${encodeURIComponent(id)}/start` });
  const text = await res.body.text();
  if (res.statusCode >= 400 && res.statusCode !== 304) {
    throw new BridgeError('DOCKER_UNAVAILABLE', `container start failed: ${res.statusCode} ${text.slice(0, 200)}`, 502);
  }
}

export interface FullContainerInspect {
  Id: string;
  Image: string; // immutable image ID actually used
  State: { Running: boolean; Status: string; ExitCode: number; OOMKilled: boolean; StartedAt: string; FinishedAt: string };
  Config: { Image: string; User: string; Labels: Record<string, string>; Cmd: string[] | null };
  HostConfig: {
    NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean;
    CapDrop: string[] | null; CapAdd: string[] | null; SecurityOpt: string[] | null;
    Memory: number; NanoCpus: number; PidsLimit: number | null;
    Binds: string[] | null; PidMode: string; IpcMode: string; Devices: unknown[] | null;
    Tmpfs: Record<string, string> | null;
  };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean }[];
}

export async function inspectContainerFull(id: string): Promise<FullContainerInspect> {
  return dockerJson<FullContainerInspect>('GET', `${API}/containers/${encodeURIComponent(id)}/json`);
}

/** Block until the container exits, bounded by timeoutMs (abort the wait, not the container). */
export async function waitContainer(id: string, opts: { timeoutMs?: number } = {}): Promise<{ statusCode: number | null; timedOut: boolean }> {
  const ac = new AbortController();
  const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
  try {
    const res = await client.request({ method: 'POST', path: `${API}/containers/${encodeURIComponent(id)}/wait`, signal: ac.signal });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw new BridgeError('DOCKER_UNAVAILABLE', `container wait failed: ${res.statusCode} ${text.slice(0, 200)}`, 502);
    }
    const j = JSON.parse(text) as { StatusCode: number };
    return { statusCode: Number(j.StatusCode), timedOut: false };
  } catch (e) {
    if (ac.signal.aborted) return { statusCode: null, timedOut: true };
    throw e instanceof BridgeError ? e : new BridgeError('DOCKER_UNAVAILABLE', `container wait error: ${(e as Error).message}`, 502);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch bounded, demultiplexed container logs. Reads at most ~maxBytes (plus a
 * small frame slack) into memory, never the full unbounded log.
 */
export async function getContainerLogs(id: string, maxBytes: number): Promise<{ stdout: string; stderr: string; bytes: number; truncated: boolean }> {
  const res = await client.request({ method: 'GET', path: `${API}/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=0` });
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new BridgeError('DOCKER_UNAVAILABLE', `container logs failed: ${res.statusCode} ${text.slice(0, 200)}`, 502);
  }
  let raw = Buffer.alloc(0);
  let truncated = false;
  const hardCap = maxBytes + 65536; // frame slack; we still clip to maxBytes below
  for await (const chunk of res.body as unknown as Readable) {
    raw = Buffer.concat([raw, chunk as Buffer]);
    if (raw.length > hardCap) { truncated = true; (res.body as unknown as Readable).destroy(); break; }
  }
  const { stdout, stderr } = demuxDockerStream(raw);
  const total = stdout.length + stderr.length;
  if (total > maxBytes) truncated = true;
  return {
    stdout: stdout.subarray(0, maxBytes).toString('utf8'),
    stderr: stderr.subarray(0, maxBytes).toString('utf8'),
    bytes: total,
    truncated,
  };
}

export async function stopContainer(id: string, timeoutSec = 2): Promise<void> {
  const res = await client.request({ method: 'POST', path: `${API}/containers/${encodeURIComponent(id)}/stop?t=${timeoutSec}` });
  await res.body.dump();
  // 304 (already stopped) / 404 (already gone) are fine.
}

export async function killContainer(id: string, signal = 'SIGKILL'): Promise<void> {
  const res = await client.request({ method: 'POST', path: `${API}/containers/${encodeURIComponent(id)}/kill?signal=${encodeURIComponent(signal)}` });
  await res.body.dump();
}

export async function removeContainer(id: string, force = true): Promise<void> {
  const res = await client.request({ method: 'DELETE', path: `${API}/containers/${encodeURIComponent(id)}?force=${force ? 1 : 0}&v=1` });
  const text = await res.body.text();
  if (res.statusCode >= 400 && res.statusCode !== 404) {
    throw new BridgeError('DOCKER_UNAVAILABLE', `container remove failed: ${res.statusCode} ${text.slice(0, 200)}`, 502);
  }
}

export async function ping(): Promise<boolean> {
  try {
    const res = await client.request({ method: 'GET', path: '/_ping' });
    await res.body.dump();
    return res.statusCode === 200;
  } catch {
    return false;
  }
}
