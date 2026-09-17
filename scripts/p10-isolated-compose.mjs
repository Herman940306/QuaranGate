#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/u;
const FORBIDDEN_FORWARD = new Set(['-p', '--project-name', '-f', '--file']);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function isolatedComposePlan(env = process.env, forwarded = []) {
  const project = env.QG_P10_COMPOSE_PROJECT?.trim();
  if (!project) throw new Error('QG_P10_COMPOSE_PROJECT is required');
  if (!PROJECT_RE.test(project)) throw new Error('QG_P10_COMPOSE_PROJECT has an invalid Compose project name');
  if (project === 'quarangate') throw new Error('refusing canonical Compose project quarangate for P10 isolated qualification');

  const rawPort = env.QG_P10_BRIDGE_PORT?.trim();
  if (!rawPort || !/^\d+$/u.test(rawPort)) throw new Error('QG_P10_BRIDGE_PORT must be an explicit integer');
  const bridgePort = Number(rawPort);
  if (!Number.isSafeInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535 || bridgePort === 8787) {
    throw new Error('QG_P10_BRIDGE_PORT must be a non-live unprivileged port in 1024..65535');
  }

  for (let index = 0; index < forwarded.length; index += 1) {
    const token = forwarded[index];
    if (FORBIDDEN_FORWARD.has(token) || token.startsWith('--project-name=') || token.startsWith('--file=')) {
      throw new Error(`forwarded Compose argument may not override guarded project/files: ${token}`);
    }
  }

  const childEnv = {
    ...env,
    QG_P10_COMPOSE_PROJECT: project,
    QG_P10_EDGE_NETWORK: `${project}-edge`,
    QG_P10_INTERNAL_NETWORK: `${project}-internal`,
    QG_P10_DATA_VOLUME: `${project}-data`,
    QG_P10_JOBS_VOLUME: `${project}-jobs`,
    BRIDGE_PORT: String(bridgePort),
  };
  const composeFiles = [path.join(REPO_ROOT, 'compose.yaml'), path.join(REPO_ROOT, 'compose.p10-isolated.yaml')];
  const dockerArgs = ['compose', '-p', project, '-f', composeFiles[0], '-f', composeFiles[1], ...forwarded];
  return { project, bridgePort, composeFiles, dockerArgs, childEnv, cwd: REPO_ROOT };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) throw new Error('supply a Docker Compose command, for example: config --quiet');
  const plan = isolatedComposePlan(process.env, argv);
  const result = spawnSync('docker', plan.dockerArgs, {
    cwd: plan.cwd,
    env: plan.childEnv,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`P10 isolated Compose refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
