import { execFileSync } from 'node:child_process';

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface IntegrationRuntimeControl {
  project: string;
  bridgeUrl: string;
}

export function integrationRuntimeControl(env: NodeJS.ProcessEnv = process.env): IntegrationRuntimeControl {
  const project = env.QG_INTEGRATION_COMPOSE_PROJECT?.trim();
  if (!project) throw new Error('QG_INTEGRATION_COMPOSE_PROJECT is required for destructive live integration tests');
  if (!PROJECT_RE.test(project)) throw new Error('QG_INTEGRATION_COMPOSE_PROJECT has an invalid Compose project name');
  if (project === 'quarangate' && env.QG_INTEGRATION_ALLOW_CANONICAL_RESTART !== '1') {
    throw new Error('refusing to restart canonical Compose project quarangate without QG_INTEGRATION_ALLOW_CANONICAL_RESTART=1');
  }

  const bridgeUrl = env.BRIDGE_URL?.trim();
  if (!bridgeUrl) throw new Error('BRIDGE_URL must be explicitly set for destructive live integration tests');
  let parsed: URL;
  try { parsed = new URL(bridgeUrl); }
  catch { throw new Error('BRIDGE_URL must be a valid URL'); }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('BRIDGE_URL for destructive live integration tests must use loopback HTTP');
  }

  return { project, bridgeUrl: parsed.toString().replace(/\/$/u, '') };
}

export function restartComposeService(project: string, service: string): void {
  execFileSync('docker', ['compose', '-p', project, 'restart', service], { stdio: 'ignore' });
}

export function composeServiceContainerId(project: string, service: string): string {
  const id = execFileSync('docker', ['compose', '-p', project, 'ps', '-q', service], { encoding: 'utf8' }).trim();
  if (!id || id.includes('\n')) throw new Error(`expected exactly one ${service} container in Compose project ${project}`);
  return id;
}

export function dockerContainerHealth(containerId: string): string {
  return execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', containerId], { encoding: 'utf8' }).trim();
}
