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

export async function ping(): Promise<boolean> {
  try {
    const res = await client.request({ method: 'GET', path: '/_ping' });
    await res.body.dump();
    return res.statusCode === 200;
  } catch {
    return false;
  }
}
