import { spawnSync } from 'node:child_process';

export const BASE_IMAGE = 'node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81';
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const SAFE_SUFFIX = /^[A-Za-z0-9._-]+$/u;
const REGISTRY_ACTIVITY = /(?:\[auth\]|pull token for|registry-1\.docker\.io|load metadata for docker\.io\/|resolve docker\.io\/)/iu;

export function localBasePlan(imageId, suffix) {
  if (!IMAGE_ID.test(imageId)) throw new Error('local base image must resolve to an immutable sha256 image ID');
  if (!suffix || !SAFE_SUFFIX.test(suffix)) throw new Error('local base tag suffix is invalid');
  const tempTag = `quarangate-p10-local-node-base:${suffix}`;
  return {
    baseImage: BASE_IMAGE,
    imageId,
    tempTag,
    buildContext: `${BASE_IMAGE}=docker-image://${tempTag}`,
  };
}

export function assertNoRegistryActivity(text) {
  if (REGISTRY_ACTIVITY.test(String(text))) throw new Error('BuildKit registry metadata/auth activity detected during local-only build');
}

export function imageExists(ref) {
  const result = spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore', shell: false });
  return result.status === 0;
}
