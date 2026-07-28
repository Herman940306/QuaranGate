/**
 * Credential delivery for the Kiro ACP runner — Phase A4.
 *
 * Lifecycle of the Kiro API key for runner containers:
 *   trusted host key file
 *     → Executor transient read (this process only)
 *       → job-scoped secret volume (bytes written via the Docker archive API)
 *         → runner RO secret file at /run/secrets/kiro-api-key
 *           → runner entrypoint exports KIRO_API_KEY for the kiro-cli child
 *
 * Security invariants:
 *   - The raw key NEVER appears in Docker Env, labels, Cmd, or logs. It is
 *     delivered as tar bytes to a volume, never as a container environment
 *     variable (verified by tests + `docker inspect`).
 *   - The raw key is NEVER stored in the job DB or returned in results.
 *   - The secret volume is job-scoped and cleaned up deterministically on
 *     success / failure / timeout / cancel / startup-orphan recovery.
 *   - Only the Executor process reads the host credential file.
 */
import fs from 'node:fs';
import { BridgeError } from '../../shared/errors.js';
import { removeVolume, listVolumesByFilter, listContainersByFilter, removeContainer } from '../docker.js';
import { SANDBOX_LABEL_NS, LABEL_MANAGED, LABEL_JOB, LABEL_RESOURCE } from './sandboxSpec.js';
import { buildTar, populateVolume } from './runnerAssets.js';
import { RUNNER_UID, RUNNER_GID } from './sandboxSpec.js';

/** Path inside the runner where the API key is mounted (RO). */
export const RUNNER_SECRET_PATH = '/run/secrets/kiro-api-key';

/** Mount target inside the helper container while populating the secret volume. */
const SECRET_MOUNT = '/secrets';

export function secretVolumeName(jobId: string): string {
  return `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-secret-${jobId}`;
}

function secretLabels(jobId: string): Record<string, string> {
  return { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'secret', [LABEL_JOB]: jobId };
}

export interface CredentialManagerOptions {
  /** Absolute path to the host credential file. */
  credentialPath: string;
  /** Image used for the short-lived volume-populate helper. */
  helperImage: string;
}

export class CredentialManager {
  private cachedKey: string | null = null;

  constructor(private readonly opts: CredentialManagerOptions) {}

  /**
   * Verify the credential file exists with safe metadata. Returns metadata only
   * (never the value).
   */
  verifyCredentialFile(): { size: number; mode: string; owner: string } {
    const path = this.opts.credentialPath;
    if (!fs.existsSync(path)) {
      throw new BridgeError('SANDBOX_FAILED', 'Kiro API key file not found', 500);
    }
    const stat = fs.statSync(path);
    const mode = (stat.mode & 0o777).toString(8);
    if ((stat.mode & 0o077) !== 0) {
      throw new BridgeError('SANDBOX_FAILED',
        `Kiro API key file has unsafe permissions (${mode}); expected 0600`, 500);
    }
    return { size: stat.size, mode, owner: `${stat.uid}:${stat.gid}` };
  }

  /** The ONLY function that reads the raw key value. Cached for the process. */
  private readKey(): string {
    if (this.cachedKey) return this.cachedKey;
    this.verifyCredentialFile();
    const raw = fs.readFileSync(this.opts.credentialPath, 'utf8').trim();
    if (raw.length < 10 || raw.length > 256) {
      throw new BridgeError('SANDBOX_FAILED',
        `Kiro API key has unexpected length (${raw.length}); expected 10-256 chars`, 500);
    }
    this.cachedKey = raw;
    return raw;
  }

  /**
   * Create a job-scoped secret volume containing the API key file. The key
   * bytes are written into the volume via the Docker archive API — they never
   * appear in the helper container's Env/Cmd/labels. Returns the volume name.
   */
  async provisionSecret(jobId: string): Promise<string> {
    const key = this.readKey();
    const volName = secretVolumeName(jobId);
    const tar = await buildTar({
      files: [{
        name: 'kiro-api-key',
        content: Buffer.from(key, 'utf8'),
        mode: 0o400,
        uid: RUNNER_UID,
        gid: RUNNER_GID,
      }],
    });
    await populateVolume({
      volumeName: volName,
      labels: secretLabels(jobId),
      helperImage: this.opts.helperImage,
      mountPath: SECRET_MOUNT,
      tar,
    });
    return volName;
  }

  /** Remove a job-scoped secret volume (idempotent). */
  async revokeSecret(jobId: string): Promise<void> {
    await removeVolume(secretVolumeName(jobId), true).catch(() => {});
  }

  /** Startup recovery: remove orphaned secret volumes + populate helpers. */
  async reconcileOrphans(): Promise<string[]> {
    const removed: string[] = [];
    const volumes = await listVolumesByFilter(
      { label: [`${LABEL_MANAGED}=true`, `${LABEL_RESOURCE}=secret`] },
    ).catch(() => []);
    for (const v of volumes) {
      await removeVolume(v.Name, true).catch(() => {});
      removed.push(v.Name);
    }
    // Any leftover populate-helper containers carry the same secret label.
    const containers = await listContainersByFilter(
      { label: [`${LABEL_MANAGED}=true`, `${LABEL_RESOURCE}=secret`] }, true,
    ).catch(() => []);
    for (const c of containers) {
      await removeContainer(c.Id, true).catch(() => {});
    }
    return removed;
  }

  /**
   * Return the raw key for a trusted host-side ACP launch (e.g. the live
   * acceptance harness that spawns kiro-cli on the host). This value is NEVER
   * passed to Docker Env — Docker delivery always uses provisionSecret().
   */
  getKeyForDirectUse(): string {
    return this.readKey();
  }
}
