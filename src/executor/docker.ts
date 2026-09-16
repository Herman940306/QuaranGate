/**
 * Minimal Docker Engine API client over the unix socket (undici).
 * Only the endpoints the executor needs are implemented — the executor's API
 * surface can never express arbitrary Docker calls.
 */
import { authorityCall, authorityStream } from '../docker-authority/client.js';
import { PassThrough, Readable } from 'node:stream';
import { BridgeError } from '../shared/errors.js';

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels: Record<string, string>;
}

export async function listContainers(all = false): Promise<ContainerSummary[]> {
  return authorityCall<ContainerSummary[]>('container.listManaged', { all });
}

export async function inspectContainer(id: string): Promise<{ State: { Running: boolean; Status: string; Health?: { Status: string } }; Config: { Image: string; Labels: Record<string, string> } }> {
  return authorityCall('container.inspectManaged', { id });
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
  const r = await authorityCall<ExecCreateResponse>('container.execManaged', { containerId, action: 'create', body });
  return r.Id;
}

export async function execInspect(execId: string): Promise<ExecInspect> {
  return authorityCall<ExecInspect>('container.execManaged', { action: 'inspect', execId });
}

/**
 * Start an exec and stream demultiplexed stdout/stderr.
 * Docker multiplexes with 8-byte frame headers: [type,0,0,0,len32be].
 */
export async function execStartStream(execId: string): Promise<{ stdout: PassThrough; stderr: PassThrough; done: Promise<void> }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const res = await authorityStream('container.execManaged', { action: 'start', execId });
  const stream = res.body;

  const done = (async () => {
    let buf = Buffer.alloc(0);
    for await (const chunk of stream as Readable) {
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
  const res = await authorityStream('container.archiveReadManaged', { containerId, path: absPath });
  const h=res.headers['x-docker-container-path-stat'];
  return { body: res.body, statHeader: typeof h === 'string' ? h : undefined };
}

/** PUT a tar stream into a container directory. */
export async function putArchive(containerId: string, absDir: string, tarBuffer: Buffer): Promise<void> {
  await authorityCall('container.archiveWriteManaged', { containerId, path: absDir, base64: tarBuffer.toString('base64') });
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
  return authorityCall('image.inspect', { ref });
}

export interface VolumeSummary { Name: string; Labels: Record<string, string> | null }

export async function createVolume(name: string, labels: Record<string, string>): Promise<void> {
  await authorityCall('volume.createManaged', { name, labels });
}

export async function removeVolume(name: string, force = true): Promise<void> {
  void force; await authorityCall('volume.removeManaged', { name });
}

export async function listVolumesByFilter(filters: Record<string, string[]>): Promise<VolumeSummary[]> {
  const r = await authorityCall<{ Volumes: VolumeSummary[] | null }>('volume.listManaged', { filters });
  return r.Volumes ?? [];
}

export async function listContainersByFilter(filters: Record<string, string[]>, all = true): Promise<ContainerSummary[]> {
  return authorityCall<ContainerSummary[]>('container.listManaged', { filters, all });
}

/** Create a container from a fully-formed, trusted-policy body. */
export async function createContainer(name: string, body: Record<string, unknown>): Promise<string> {
  const r = await authorityCall<{ Id: string }>('container.createManaged', { name, body });
  return r.Id;
}

export async function startContainer(id: string): Promise<void> { await authorityCall('container.startManaged', { id });
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
  return authorityCall<FullContainerInspect>('container.inspectManaged', { id });
}

/** Block until the container exits, bounded by timeoutMs. */
export async function waitContainer(id: string, opts: { timeoutMs?: number } = {}): Promise<{ statusCode: number | null; timedOut: boolean }> {
  try { const r=await authorityCall<{StatusCode:number}>('container.waitManaged',{id,timeoutMs:opts.timeoutMs}); return {statusCode:Number(r.StatusCode),timedOut:false}; } catch(e) { if(e instanceof BridgeError && e.message.includes('timeout')) return {statusCode:null,timedOut:true}; throw e; }
}

/**
 * Fetch bounded, demultiplexed container logs. Reads at most ~maxBytes (plus a
 * small frame slack) into memory, never the full unbounded log.
 */
export async function getContainerLogs(id: string, maxBytes: number): Promise<{ stdout: string; stderr: string; bytes: number; truncated: boolean }> {
  const packed=await authorityCall<{base64:string}>('container.logsManaged',{id,maxBytes});
  let raw = Buffer.from(packed.base64, 'base64');
  let truncated = raw.length > maxBytes + 65536;
  if (truncated) raw = raw.subarray(0, maxBytes + 65536);
  const { stdout, stderr } = demuxDockerStream(raw);
  const total = stdout.length + stderr.length;
  if (total > maxBytes) truncated = true;
  // One shared public budget across stdout+stderr. Returning maxBytes from each
  // stream would double the advertised bound. Preserve stdout first (Docker's
  // primary application stream), then spend the remainder on stderr.
  const outBytes = Math.min(stdout.length, maxBytes);
  const errBudget = Math.max(0, maxBytes - outBytes);
  return {
    stdout: stdout.subarray(0, outBytes).toString('utf8'),
    stderr: stderr.subarray(0, errBudget).toString('utf8'),
    bytes: total,
    truncated,
  };
}

export async function stopContainer(id: string, timeoutSec = 2): Promise<void> { await authorityCall('container.stopManaged',{id,timeoutSec});
}

export async function restartContainer(id: string, timeoutSec = 10): Promise<void> { await authorityCall('container.restartManaged',{id,timeoutSec});
}

export async function killContainer(id: string, signal = 'SIGKILL'): Promise<void> { await authorityCall('container.killManaged',{id,signal});
}

export async function removeContainer(id: string, force = true): Promise<void> { void force; await authorityCall('container.removeManaged',{id});
}

// ---------------------------------------------------------------------------
// A4 network primitives (job-scoped backend-only egress).
//
// Added strictly for the trusted internal runner sandbox. Never exposed as an
// executor route; bodies are built from trusted policy only. Enumeration and
// removal are always scoped by the managed-ownership label filter.
// ---------------------------------------------------------------------------

export interface NetworkSummary {
  Id: string;
  Name: string;
  Labels: Record<string, string> | null;
  /** Container IDs connected to the network (keyed by container ID). Present in Docker API /networks response. */
  Containers: Record<string, unknown> | null | undefined;
}

/** Create a user-defined network. `internal:true` gives NO external route. */
export async function createNetwork(name: string, opts: { internal: boolean; labels: Record<string, string> }): Promise<string> {
  const r=await authorityCall<{Id:string}>('network.createManaged',{name,internal:opts.internal,labels:opts.labels}); return r.Id;
}

export async function removeNetwork(idOrName: string): Promise<void> { await authorityCall('network.removeManaged',{id:idOrName});
}

export async function listNetworksByFilter(filters: Record<string, string[]>): Promise<NetworkSummary[]> {
  return authorityCall<NetworkSummary[]>('network.listManaged', { filters });
}

/** Attach an existing container to a network, optionally with DNS aliases. */
export async function connectNetwork(networkIdOrName: string, containerId: string, aliases?: string[]): Promise<void> { await authorityCall('network.connectManaged',{network:networkIdOrName,container:containerId,aliases:aliases??[]});
}

export async function ping(): Promise<boolean> { try { return (await authorityCall<{ok:boolean}>('ping')).ok; } catch { return false; }
}
