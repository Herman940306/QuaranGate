/**
 * N1D runtime identity cutover (§47.11) — asserts the deployed Compose identity
 * and the deliberately-retained compatibility identifiers.
 *
 * These are config-shape assertions, not a Docker test: they fail loudly if a
 * later edit silently reintroduces a legacy identifier or drops one of the two
 * identifiers that are retained under an approved decision.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';

const composePath = new URL('../../compose.yaml', import.meta.url);
const compose = YAML.parse(fs.readFileSync(composePath, 'utf8')) as {
  name: string;
  services: Record<string, {
    image: string;
    build?: { args?: Record<string, string> };
    volumes?: string[];
    secrets?: unknown[];
  }>;
  networks: Record<string, { name: string; internal?: boolean }>;
  volumes: Record<string, { name: string }>;
  secrets: Record<string, { file: string }>;
};

describe('N1D Compose runtime identity', () => {
  it('uses the canonical QuaranGate Compose project', () => {
    expect(compose.name).toBe('quarangate');
  });

  it('names both networks under the QuaranGate identity', () => {
    expect(compose.networks.edge.name).toBe('quarangate-edge');
    expect(compose.networks.internal.name).toBe('quarangate-internal');
  });

  it('keeps the internal network internal (no egress path for the executor)', () => {
    expect(compose.networks.internal.internal).toBe(true);
  });

  it('recreates the disposable OAuth volume under the QuaranGate name (DECISION-1)', () => {
    expect(compose.volumes['bridge-data'].name).toBe('quarangate-data');
  });

  it('RETAINS the durable job volume physical name exactly (DECISION-2)', () => {
    // Renaming or copying this volume for branding would risk the only store in
    // this stack that cannot be rebuilt from source.
    expect(compose.volumes['bridge-jobs'].name).toBe('mcp-bridge-jobs');
  });

  it('defaults both service images to the QuaranGate family', () => {
    expect(compose.services.gateway.image).toBe('${GATEWAY_IMAGE:-quarangate:latest}');
    expect(compose.services.executor.image).toBe('${EXECUTOR_IMAGE:-quarangate:latest}');
  });

  it('defaults the host secret to the QuaranGate path (DECISION-4)', () => {
    expect(compose.secrets.kiro_api_key.file)
      .toBe('${AGENT_KIRO_KEY_FILE:-/home/herman/.config/quarangate/kiro-api-key}');
  });

  it('threads build-time provenance into both services', () => {
    expect(compose.services.gateway.build?.args?.GIT_REVISION).toBe('${GIT_REVISION:-unknown}');
    expect(compose.services.executor.build?.args?.GIT_REVISION).toBe('${GIT_REVISION:-unknown}');
  });

  it('never mounts the docker socket into the gateway', () => {
    const mounts = compose.services.gateway.volumes ?? [];
    expect(mounts.some((m) => m.includes('docker.sock'))).toBe(false);
    expect((compose.services.executor.volumes ?? []).some((m) => m.includes('docker.sock'))).toBe(true);
  });

  it('delivers the Kiro secret to the executor only, never the gateway', () => {
    expect(compose.services.executor.secrets).toBeDefined();
    expect(compose.services.gateway.secrets).toBeUndefined();
  });
});

describe('N1D Dockerfile provenance', () => {
  const dockerfile = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');

  it('accepts the revision as a build arg rather than baking it into source', () => {
    expect(dockerfile).toContain('ARG GIT_REVISION=unknown');
  });

  it('emits the OCI revision and source labels', () => {
    expect(dockerfile).toContain('org.opencontainers.image.revision="${GIT_REVISION}"');
    expect(dockerfile).toContain('org.opencontainers.image.source="${SOURCE_URL}"');
    expect(dockerfile).toContain('https://github.com/Herman940306/QuaranGate');
  });
});
