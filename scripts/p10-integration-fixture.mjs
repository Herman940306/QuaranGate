#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/u;
const PRINCIPALS = Object.freeze(['vscode', 'readonly', 'forbidden', 'itest_full', 'itest_agent_owner', 'itest_agent_other']);

function argMap(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith('--') || v === undefined || v.startsWith('--') || out.has(k)) throw new Error('arguments must be unique --name value pairs');
    out.set(k, v);
  }
  return out;
}

function requireArg(args, name) {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runGit(sourceRoot, argv) {
  const r = spawnSync('git', ['-C', sourceRoot, ...argv], { encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed for source root`);
  return r.stdout.trim();
}

function sha256Text(value) { return createHash('sha256').update(value).digest('hex'); }
function sha256File(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function newKey(id) { return `mcpb_${id}_${randomBytes(32).toString('base64url')}`; }
function token(prefix) { return `${prefix}_${randomBytes(32).toString('base64url')}`; }

function writePrivate(file, body) {
  writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
}

export function buildFixtureDocuments({ targetProject, sourceRoot, keys }) {
  const hash = (id) => sha256Text(keys[id]);
  const targetScopes = ['targets:read', 'files:read', 'files:write', 'files:delete', 'terminal:exec', 'git:read', 'process:read'];
  const clients = { clients: [
    { id: 'vscode', name: 'P10 disposable VS Code', keyHash: hash('vscode'), enabled: true, scopes: targetScopes, targets: ['demo'], rateLimit: 1000 },
    { id: 'readonly', name: 'P10 disposable read-only', keyHash: hash('readonly'), enabled: true, scopes: ['targets:read', 'files:read'], targets: ['demo'], rateLimit: 1000 },
    { id: 'forbidden', name: 'P10 disposable forbidden-target', keyHash: hash('forbidden'), enabled: true, scopes: ['targets:read', 'files:read'], targets: [], rateLimit: 1000 },
    { id: 'itest_full', name: 'P10 disposable full target client', keyHash: hash('itest_full'), enabled: true, scopes: targetScopes, targets: ['demo'], rateLimit: 1000 },
    { id: 'itest_agent_owner', name: 'P10 disposable agent owner', keyHash: hash('itest_agent_owner'), enabled: true, scopes: ['targets:read', 'agents:read', 'agents:dispatch', 'agents:cancel'], targets: ['demo'], projects: ['mcp-ide-bridge'], agentBackends: ['kiro'], agentProfiles: ['audit', 'plan', 'implement', 'review'], rateLimit: 1000 },
    { id: 'itest_agent_other', name: 'P10 disposable agent non-owner', keyHash: hash('itest_agent_other'), enabled: true, scopes: ['agents:read', 'agents:cancel'], targets: [], projects: ['mcp-ide-bridge'], agentBackends: ['kiro'], agentProfiles: ['audit'], rateLimit: 1000 },
  ] };
  const bridge = { discovery: { enabled: false }, targets: [{ id: 'demo', composeProject: targetProject, composeService: 'dev', workspace: '/workspace' }] };
  const agents = {
    backends: [{ id: 'kiro', enabled: true, profiles: ['audit', 'plan', 'implement', 'review'], defaultResourcePolicy: 'standard' }],
    projects: [{ id: 'mcp-ide-bridge', hostPath: sourceRoot, worktreeId: 'p10-qualification', gitRequired: true, backends: ['kiro'], profiles: ['audit', 'plan', 'implement', 'review'], guardedPaths: ['.env', 'config/clients.yaml', 'config/bridge.yaml', '**/*.pem', '**/id_rsa*'], sensitiveReadGlobs: [] }],
    profiles: [
      { id: 'audit', workspaceAccess: 'read-only', shellPolicy: 'read-only', gitPolicy: 'read', networkPolicy: 'backend-only', defaultResourcePolicy: 'economy' },
      { id: 'plan', workspaceAccess: 'read-only', shellPolicy: 'none', gitPolicy: 'read', networkPolicy: 'backend-only', defaultResourcePolicy: 'economy' },
      { id: 'implement', workspaceAccess: 'sandbox-write', shellPolicy: 'validation', gitPolicy: 'sandbox', networkPolicy: 'backend-only', defaultResourcePolicy: 'standard' },
      { id: 'review', workspaceAccess: 'read-only', shellPolicy: 'validation', gitPolicy: 'read', networkPolicy: 'backend-only', defaultResourcePolicy: 'standard' },
    ],
    resourcePolicies: [
      { id: 'economy', modelClass: 'fast', maxRuntimeMs: 600000, maxCpuMillicores: 1000, maxMemoryBytes: 1073741824, maxPids: 128, maxOutputBytes: 262144, maxEvidenceBytes: 10485760, networkPolicy: 'backend-only', retentionClass: 'ephemeral' },
      { id: 'standard', modelClass: 'standard', maxRuntimeMs: 1800000, maxCpuMillicores: 2000, maxMemoryBytes: 2147483648, maxPids: 256, maxOutputBytes: 262144, maxEvidenceBytes: 52428800, networkPolicy: 'backend-only', retentionClass: 'short' },
      { id: 'deep', modelClass: 'deep', maxRuntimeMs: 3600000, maxCpuMillicores: 4000, maxMemoryBytes: 4294967296, maxPids: 512, maxOutputBytes: 262144, maxEvidenceBytes: 104857600, maxProviderCredits: 100, networkPolicy: 'backend-only', retentionClass: 'audit' },
    ],
  };
  return { clients, bridge, agents };
}

export function createFixture(argv = process.argv.slice(2)) {
  const args = argMap(argv);
  const outputDir = path.resolve(requireArg(args, '--output-dir'));
  const sourceRoot = path.resolve(requireArg(args, '--source-root'));
  const sourceCommit = requireArg(args, '--source-commit');
  const coreProject = requireArg(args, '--core-project');
  const targetProject = requireArg(args, '--target-project');
  const bridgePortRaw = requireArg(args, '--bridge-port');
  const bundle = path.resolve(requireArg(args, '--bundle'));

  if (!path.isAbsolute(requireArg(args, '--output-dir'))) throw new Error('--output-dir must be absolute');
  if (!path.isAbsolute(requireArg(args, '--source-root'))) throw new Error('--source-root must be absolute');
  if (!path.isAbsolute(requireArg(args, '--bundle'))) throw new Error('--bundle must be absolute');
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error('--source-commit must be 40 lowercase hex');
  for (const [name, value] of [['--core-project', coreProject], ['--target-project', targetProject]]) {
    if (!PROJECT_RE.test(value)) throw new Error(`${name} has an invalid Compose project name`);
  }
  if (coreProject === 'quarangate') throw new Error('refusing canonical core project');
  if (targetProject === 'mcp-ide-bridge-testtarget') throw new Error('refusing canonical integration target project');
  if (targetProject === coreProject) throw new Error('core and target projects must differ');
  if (!/^\d+$/u.test(bridgePortRaw)) throw new Error('--bridge-port must be an integer');
  const bridgePort = Number(bridgePortRaw);
  if (!Number.isSafeInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535 || bridgePort === 8787) throw new Error('--bridge-port must be a non-live unprivileged port');
  if (existsSync(outputDir)) throw new Error('output directory already exists; refusing overwrite');
  if (!existsSync(bundle) || !statSync(bundle).isDirectory()) throw new Error('verified npm bundle directory is missing');
  if (runGit(sourceRoot, ['rev-parse', 'HEAD']) !== sourceCommit) throw new Error('source HEAD does not match --source-commit');
  if (runGit(sourceRoot, ['status', '--porcelain']) !== '') throw new Error('source worktree is not clean');
  const sourceTree = runGit(sourceRoot, ['rev-parse', 'HEAD^{tree}']);

  const verify = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/npm-offline-bundle.mjs'), 'verify', '--bundle', bundle, '--lockfile', path.join(sourceRoot, 'package-lock.json'), '--descriptor', path.join(sourceRoot, 'build/npm-dependencies.json'), '--json'], { encoding: 'utf8', shell: false });
  if (verify.status !== 0) throw new Error('npm offline bundle verification failed');

  const keys = Object.fromEntries(PRINCIPALS.map((id) => [id, newKey(id)]));
  const docs = buildFixtureDocuments({ targetProject, sourceRoot, keys });
  const configDir = path.join(outputDir, 'config');
  mkdirSync(outputDir, { mode: 0o700 });
  chmodSync(outputDir, 0o700);
  mkdirSync(configDir, { mode: 0o700 });
  chmodSync(configDir, 0o700);

  try {
    writePrivate(path.join(configDir, 'clients.yaml'), YAML.stringify(docs.clients));
    writePrivate(path.join(configDir, 'bridge.yaml'), YAML.stringify(docs.bridge));
    writePrivate(path.join(configDir, 'agents.yaml'), YAML.stringify(docs.agents));
    writePrivate(path.join(outputDir, 'keys.env'), PRINCIPALS.map((id) => `KEY_${id}=${keys[id]}`).join('\n') + '\n');
    writePrivate(path.join(outputDir, 'kiro-placeholder'), '');

    let dockerGid = '1001';
    try {
      const s = statSync('/var/run/docker.sock');
      if (!s.isSocket()) throw new Error('not socket');
      dockerGid = String(s.gid);
    } catch { /* config generation remains possible before Docker startup; owner preflight rechecks */ }

    const short = sourceCommit.slice(0, 7);
    const runtimeEnv = {
      QG_P10_COMPOSE_PROJECT: coreProject,
      QG_P10_TARGET_PROJECT: targetProject,
      QG_P10_BRIDGE_PORT: String(bridgePort),
      QG_P10_CONFIG_DIR: configDir,
      BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
      QG_INTEGRATION_COMPOSE_PROJECT: coreProject,
      KEYS_ENV: path.join(outputDir, 'keys.env'),
      GIT_REVISION: sourceCommit,
      GATEWAY_IMAGE: `quarangate:p10-${short}-core`,
      EXECUTOR_IMAGE: `quarangate:p10-${short}-core`,
      DOCKER_AUTHORITY_IMAGE: `quarangate:p10-${short}-core`,
      QUARANGATE_NPM_BUNDLE_PATH: bundle,
      INTERNAL_TOKEN: token('qg_p10_internal'),
      DOCKER_AUTHORITY_TOKEN: token('qg_p10_docker_authority'),
      DOCKER_GID: dockerGid,
      AGENT_KIRO_KEY_FILE: path.join(outputDir, 'kiro-placeholder'),
    };
    writePrivate(path.join(outputDir, 'runtime.env'), Object.entries(runtimeEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

    const validationEnv = {
      ...process.env,
      CLIENTS_CONFIG: path.join(configDir, 'clients.yaml'),
      BRIDGE_CONFIG: path.join(configDir, 'bridge.yaml'),
      AGENTS_CONFIG: path.join(configDir, 'agents.yaml'),
    };
    // GitHub and IDE-session configuration are intentionally absent in this
    // isolated integration fixture. The validator treats these surfaces as
    // optional only when their environment variables are unset; pointing the
    // variables at nonexistent sentinels incorrectly makes them mandatory.
    delete validationEnv.GITHUB_CONFIG;
    delete validationEnv.IDE_SESSIONS_CONFIG;
    const validation = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/validate-config.mjs')], {
      // Validate from the exact committed bootstrap tree so ignored operator
      // config in sourceRoot cannot silently activate optional GitHub/IDE
      // surfaces during disposable fixture preparation.
      cwd: REPO_ROOT,
      env: validationEnv,
      encoding: 'utf8',
      shell: false,
    });
    if (validation.status !== 0) throw new Error(`generated config validation failed: ${validation.stderr.trim() || validation.stdout.trim()}`);

    const metadata = {
      schemaVersion: 1,
      sourceCommit, sourceTree, sourceRoot, coreProject, targetProject, bridgePort,
      principalIds: [...PRINCIPALS],
      files: {
        clientsSha256: sha256File(path.join(configDir, 'clients.yaml')),
        bridgeSha256: sha256File(path.join(configDir, 'bridge.yaml')),
        agentsSha256: sha256File(path.join(configDir, 'agents.yaml')),
      },
    };
    writePrivate(path.join(outputDir, 'fixture.json'), JSON.stringify(metadata, null, 2) + '\n');
    return { outputDir, configDir, keysEnv: path.join(outputDir, 'keys.env'), runtimeEnv: path.join(outputDir, 'runtime.env'), metadata };
  } catch (error) {
    rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = createFixture();
    process.stdout.write(`${JSON.stringify({ ok: true, outputDir: result.outputDir, configDir: result.configDir, keysEnv: result.keysEnv, runtimeEnv: result.runtimeEnv, metadata: result.metadata }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`P10 integration fixture refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
