#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/u;
const FORBIDDEN_FORWARD = new Set(['-p', '--project-name', '-f', '--file']);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_ROOT = path.join(REPO_ROOT, 'test-target');

export function isolatedTargetPlan(env = process.env, forwarded = []) {
  const project = env.QG_P10_TARGET_PROJECT?.trim();
  if (!project) throw new Error('QG_P10_TARGET_PROJECT is required');
  if (!PROJECT_RE.test(project)) throw new Error('QG_P10_TARGET_PROJECT has an invalid Compose project name');
  if (project === 'mcp-ide-bridge-testtarget') throw new Error('refusing canonical integration target project');
  if (env.QG_P10_COMPOSE_PROJECT?.trim() === project) throw new Error('target project must differ from the P10 core Compose project');

  for (const token of forwarded) {
    if (FORBIDDEN_FORWARD.has(token) || token.startsWith('--project-name=') || token.startsWith('--file=')) {
      throw new Error(`forwarded Compose argument may not override guarded project/files: ${token}`);
    }
  }

  const childEnv = {
    ...env,
    QG_P10_TARGET_PROJECT: project,
    QG_P10_TARGET_IMAGE: `mcp-bridge-testtarget:${project}`,
    QG_P10_TARGET_DEV_CONTAINER: `${project}-dev`,
    QG_P10_TARGET_DECOY_CONTAINER: `${project}-decoy`,
  };
  const composeFiles = [path.join(TARGET_ROOT, 'compose.yaml'), path.join(TARGET_ROOT, 'compose.p10-isolated.yaml')];
  const dockerArgs = ['compose', '-p', project, '-f', composeFiles[0], '-f', composeFiles[1], ...forwarded];
  return { project, composeFiles, dockerArgs, childEnv, cwd: TARGET_ROOT };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) throw new Error('supply a Docker Compose command, for example: config --quiet');
  const plan = isolatedTargetPlan(process.env, argv);
  const result = spawnSync('docker', plan.dockerArgs, { cwd: plan.cwd, env: plan.childEnv, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`P10 isolated target refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
