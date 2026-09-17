import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const BASE_IMAGE = 'node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81';
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REGISTRY_ACTIVITY = /(?:\[auth\]|pull token for|registry-1\.docker\.io|load metadata for docker\.io\/|resolve docker\.io\/)/iu;

function checked(command, argv) {
  const result = spawnSync(command, argv, { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || '';
    throw new Error(`${command} ${argv.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout?.trim() ?? '';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validateOciLayout(layoutDir) {
  const layoutPath = path.resolve(layoutDir);
  const markerPath = path.join(layoutPath, 'oci-layout');
  const indexPath = path.join(layoutPath, 'index.json');
  const blobsPath = path.join(layoutPath, 'blobs', 'sha256');
  if (!existsSync(markerPath) || !existsSync(indexPath) || !existsSync(blobsPath)) {
    throw new Error('local image export is not an OCI image layout');
  }

  let marker;
  let index;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (error) {
    throw new Error('local OCI layout metadata is not valid JSON', { cause: error });
  }
  if (marker?.imageLayoutVersion !== '1.0.0') throw new Error('local OCI layout version is not 1.0.0');
  if (index?.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new Error('local OCI layout must contain exactly one top-level manifest descriptor');
  }

  const descriptor = index.manifests[0];
  if (!OCI_DIGEST.test(descriptor?.digest ?? '')) throw new Error('local OCI layout descriptor digest is invalid');
  if (!Number.isSafeInteger(descriptor?.size) || descriptor.size <= 0) throw new Error('local OCI layout descriptor size is invalid');
  const digestHex = descriptor.digest.slice('sha256:'.length);
  const blobPath = path.join(blobsPath, digestHex);
  if (!existsSync(blobPath)) throw new Error('local OCI layout descriptor blob is missing');
  const blob = readFileSync(blobPath);
  if (blob.length !== descriptor.size || statSync(blobPath).size !== descriptor.size) throw new Error('local OCI layout descriptor size mismatch');
  if (sha256(blob) !== digestHex) throw new Error('local OCI layout descriptor hash mismatch');

  return { layoutDir: layoutPath, digest: descriptor.digest, mediaType: descriptor.mediaType ?? null };
}

export function materializeLocalOciLayout(imageId, prefix = 'quarangate-p10-local-image-') {
  if (!IMAGE_ID.test(imageId)) throw new Error('local image must resolve to an immutable sha256 image ID');
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const archive = path.join(root, 'image.tar');
  const layoutDir = path.join(root, 'layout');
  mkdirSync(layoutDir, { mode: 0o700 });
  try {
    checked('docker', ['image', 'save', '--output', archive, imageId]);
    checked('tar', ['--no-same-owner', '-xf', archive, '-C', layoutDir]);
    rmSync(archive, { force: true });
    return { root, imageId, ...validateOciLayout(layoutDir) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function ociLayoutBuildContext(name, layout) {
  if (!SAFE_CONTEXT.test(name)) throw new Error('OCI build context name is invalid');
  if (!layout || !path.isAbsolute(layout.layoutDir) || !OCI_DIGEST.test(layout.digest ?? '')) {
    throw new Error('OCI build context requires an absolute validated layout and digest');
  }
  return `${name}=oci-layout://${layout.layoutDir}@${layout.digest}`;
}

export function cleanupLocalOciLayout(layout) {
  if (layout?.root) rmSync(layout.root, { recursive: true, force: true });
}

export function renderOfflineDockerfile(source) {
  const buildLine = `FROM ${BASE_IMAGE} AS build`;
  const runtimeLine = `FROM ${BASE_IMAGE} AS runtime`;
  const lines = String(source).split(/\r?\n/u);
  const buildMatches = lines.filter((line) => line === buildLine).length;
  const runtimeMatches = lines.filter((line) => line === runtimeLine).length;
  if (buildMatches !== 1 || runtimeMatches !== 1) {
    throw new Error('tracked Dockerfile pinned base contract drifted');
  }
  return lines.map((line) => {
    if (line === buildLine) return 'FROM p10_node_base AS build';
    if (line === runtimeLine) return 'FROM p10_node_base AS runtime';
    return line;
  }).join('\n');
}

export function assertNoRegistryActivity(text) {
  if (REGISTRY_ACTIVITY.test(String(text))) throw new Error('BuildKit registry metadata/auth activity detected during local-only build');
}

export function imageExists(ref) {
  const result = spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore', shell: false });
  return result.status === 0;
}
