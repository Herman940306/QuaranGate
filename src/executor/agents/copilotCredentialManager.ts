/** Job-scoped credential delivery for governed GitHub Copilot CLI workers. */
import fs from 'node:fs';
import { BridgeError } from '../../shared/errors.js';
import { removeVolume } from '../docker.js';
import { buildTar, populateVolume } from './runnerAssets.js';
import {
  LABEL_JOB,
  LABEL_MANAGED,
  LABEL_RESOURCE,
  RUNNER_GID,
  RUNNER_UID,
  SANDBOX_LABEL_NS,
} from './sandboxSpec.js';

export const COPILOT_RUNNER_SECRET_PATH = '/run/secrets/copilot-github-token';
const SECRET_MOUNT = '/secrets';

export function copilotSecretVolumeName(jobId: string): string {
  return `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-copilot-secret-${jobId}`;
}

export interface CopilotCredentialManagerOptions {
  credentialPath: string;
  helperImage: string;
}

export class CopilotCredentialManager {
  constructor(private readonly opts: CopilotCredentialManagerOptions) {}

  /** Verify safe metadata. Never returns credential bytes. */
  verifyCredentialFile(): { size: number; mode: string; owner: string } {
    const path = this.opts.credentialPath;
    if (!fs.existsSync(path)) {
      throw new BridgeError('SANDBOX_FAILED', 'Copilot credential file not found', 500);
    }
    const stat = fs.lstatSync(path);
    const mode = (stat.mode & 0o777).toString(8);
    if (!stat.isFile()) {
      throw new BridgeError('SANDBOX_FAILED', 'Copilot credential path is not a regular file', 500);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new BridgeError(
        'SANDBOX_FAILED',
        `Copilot credential file has unsafe permissions (${mode}); expected 0600`,
        500,
      );
    }
    if (stat.size < 10 || stat.size > 1024) {
      throw new BridgeError('SANDBOX_FAILED', 'Copilot credential file has invalid size', 500);
    }
    return { size: stat.size, mode, owner: `${stat.uid}:${stat.gid}` };
  }

  private readToken(): string {
    this.verifyCredentialFile();
    let fd: number | null = null;
    try {
      fd = fs.openSync(
        this.opts.credentialPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 10 || stat.size > 1024) {
        throw new BridgeError('SANDBOX_FAILED', 'Copilot credential file metadata changed', 500);
      }
      const token = fs.readFileSync(fd, 'utf8').trim();
      if (token.length < 10 || token.length > 1024 || /[\r\n\0]/.test(token)) {
        throw new BridgeError('SANDBOX_FAILED', 'Copilot credential has invalid format', 500);
      }
      return token;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('SANDBOX_FAILED', 'Copilot credential could not be read safely', 500);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  /** Secret bytes travel only through Docker archive into a job-owned volume. */
  async provisionSecret(jobId: string): Promise<string> {
    const token = this.readToken();
    const volumeName = copilotSecretVolumeName(jobId);
    const tar = await buildTar({
      files: [{
        name: 'copilot-github-token',
        content: Buffer.from(token, 'utf8'),
        mode: 0o400,
        uid: RUNNER_UID,
        gid: RUNNER_GID,
      }],
    });
    await populateVolume({
      volumeName,
      labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_RESOURCE]: 'secret',
        [LABEL_JOB]: jobId,
      },
      helperImage: this.opts.helperImage,
      mountPath: SECRET_MOUNT,
      tar,
    });
    return volumeName;
  }

  async revokeSecret(jobId: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await removeVolume(copilotSecretVolumeName(jobId), true);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new BridgeError(
      'SANDBOX_FAILED',
      `Copilot credential volume revocation failed after 3 attempts: ${lastError instanceof Error ? lastError.name : 'unknown error'}`,
      500,
    );
  }
}
