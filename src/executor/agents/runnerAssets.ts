/**
 * Runner asset delivery — Phase A4.
 *
 * Delivers small trusted files (the API-key secret; the per-job bridge agent
 * config; runner settings) into job-scoped Docker volumes WITHOUT ever placing
 * their contents in a container's `Env`, `Cmd`, labels or logs. The mechanism is
 * a minimal in-memory tar written into a volume via the Docker archive API
 * (`putArchive`) against a short-lived helper container. The raw secret never
 * leaves Executor memory except as bytes inside the volume file.
 *
 * This module contains no policy: callers pass exactly the files to write.
 */
import { pack as tarPack } from 'tar-stream';
import { BridgeError } from '../../shared/errors.js';
import {
  createVolume, removeVolume, createContainer, startContainer,
  waitContainer, removeContainer, putArchive,
} from '../docker.js';

// ---------------------------------------------------------------------------
// Tar building (via the existing tar-stream dependency).
// ---------------------------------------------------------------------------

export interface TarFile {
  /** Path relative to the extraction root (no leading slash). */
  name: string;
  content: Buffer;
  mode?: number;
  uid?: number;
  gid?: number;
}

export interface TarDir {
  name: string; // must end with '/'
  mode?: number;
  uid?: number;
  gid?: number;
}

/** Build a tar archive (as a single Buffer) of the given directories + files. */
export function buildTar(entries: { dirs?: TarDir[]; files?: TarFile[] }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = tarPack();
    const chunks: Buffer[] = [];
    p.on('data', (c: Buffer) => chunks.push(c));
    p.on('error', reject);
    p.on('end', () => resolve(Buffer.concat(chunks)));

    for (const d of entries.dirs ?? []) {
      if (!d.name.endsWith('/')) { reject(new Error(`tar dir must end with '/': ${d.name}`)); return; }
      p.entry({ name: d.name, type: 'directory', mode: d.mode ?? 0o700, uid: d.uid ?? 1000, gid: d.gid ?? 1000 });
    }
    for (const f of entries.files ?? []) {
      p.entry({ name: f.name, mode: f.mode ?? 0o600, uid: f.uid ?? 1000, gid: f.gid ?? 1000 }, f.content);
    }
    p.finalize();
  });
}

// ---------------------------------------------------------------------------
// Volume population.
// ---------------------------------------------------------------------------

/**
 * Create a labelled volume and extract `tar` into `mountPath` inside it, using a
 * short-lived helper container. The helper has NO network, a read-only rootfs,
 * cap-drop ALL, and is removed immediately. No secret ever enters the helper's
 * Env/Cmd — the bytes are streamed as a tar body to the archive API.
 */
export async function populateVolume(opts: {
  volumeName: string;
  labels: Record<string, string>;
  helperImage: string;
  mountPath: string;
  tar: Buffer;
}): Promise<void> {
  await createVolume(opts.volumeName, opts.labels);
  let containerId: string | undefined;
  try {
    // A helper that exits immediately; the volume is attached at creation, so
    // the archive PUT lands in the volume. Start+wait guarantees the named
    // volume is initialised before we remove the helper.
    containerId = await createContainer(`${opts.volumeName}-init`, {
      Image: opts.helperImage,
      User: '0:0',
      Cmd: ['true'],
      Labels: opts.labels,
      NetworkDisabled: true,
      HostConfig: {
        AutoRemove: false,
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'none',
        Mounts: [{ Type: 'volume', Source: opts.volumeName, Target: opts.mountPath, ReadOnly: false }],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
        Memory: 32 * 1024 * 1024,
        PidsLimit: 8,
      },
    });
    // Start+wait so the volume is initialised, then extract the tar into it.
    await startContainer(containerId);
    await waitContainer(containerId, { timeoutMs: 10_000 });
    await putArchive(containerId, opts.mountPath, opts.tar);
  } catch (e) {
    if (containerId) await removeContainer(containerId, true).catch(() => {});
    await removeVolume(opts.volumeName, true).catch(() => {});
    throw e instanceof BridgeError ? e
      : new BridgeError('SANDBOX_FAILED', `volume population failed: ${(e as Error).message}`, 500);
  } finally {
    if (containerId) await removeContainer(containerId, true).catch(() => {});
  }
}
