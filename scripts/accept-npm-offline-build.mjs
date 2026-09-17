#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { canonicalJson } from './npm-offline-bundle.mjs';
import { BASE_IMAGE, assertNoRegistryActivity, localBasePlan } from './offline-local-base.mjs';

const EXPECTED_LOCK_SHA256 = '5ad727697de394442f04514bc391e3367af98d7efb5fc822ef3d87d1cda1b570';
const EXPECTED_TINI_SHA256 = '1358f1be32dc2a0dd8084dbda675c3b3dde8352b519b7b8a65573262551ad0fc';

class AcceptanceError extends Error {}

function parseArgs(argv) {
  const options = new Map();
  let prepare = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--prepare') {
      prepare = true;
      continue;
    }
    if (!['--artifact-root', '--bundle'].includes(token)) throw new AcceptanceError(`unsupported argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new AcceptanceError(`${token} requires a value`);
    if (options.has(token)) throw new AcceptanceError(`duplicate argument: ${token}`);
    options.set(token, value);
    index += 1;
  }
  const artifactRoot = options.get('--artifact-root') ?? process.env.QUARANGATE_NPM_ARTIFACT_ROOT;
  const bundle = options.get('--bundle');
  if (!bundle && !artifactRoot) {
    throw new AcceptanceError('supply --bundle, --artifact-root, or QUARANGATE_NPM_ARTIFACT_ROOT');
  }
  return {
    prepare,
    artifactRoot: artifactRoot ? path.resolve(artifactRoot) : null,
    bundle: bundle ? path.resolve(bundle) : null,
  };
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const result = { code: code ?? 1, signal, stdout, stderr };
      if (code === 0) resolve(result);
      else reject(Object.assign(new AcceptanceError(`${command} exited with ${code ?? signal}`), { result }));
    });
  });
}

function runVisible(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new AcceptanceError(`${command} exited with ${code ?? signal}`));
    });
  });
}

function runVisibleCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { const text = String(chunk); stdout += text; process.stdout.write(text); });
    child.stderr?.on('data', (chunk) => { const text = String(chunk); stderr += text; process.stderr.write(text); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const result = { code: code ?? 1, signal, stdout, stderr };
      if (code === 0) resolve(result);
      else reject(Object.assign(new AcceptanceError(`${command} exited with ${code ?? signal}`), { result }));
    });
  });
}

async function expectFailure(command, args, pattern) {
  try {
    await runCapture(command, args);
  } catch (error) {
    const combined = `${error.result?.stdout ?? ''}\n${error.result?.stderr ?? ''}`;
    if (!pattern.test(combined)) throw new AcceptanceError(`negative test failed for unexpected reason: ${combined.trim()}`);
    return combined;
  }
  throw new AcceptanceError(`negative test unexpectedly passed: ${command} ${args.join(' ')}`);
}

async function sha256File(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function dockerImageInfo(reference) {
  const result = await runCapture('docker', [
    'image', 'inspect', reference, '--format', '{{.Id}}|{{.Os}}|{{.Architecture}}|{{json .RepoDigests}}',
  ]);
  const [id, platformOs, architecture, digests] = result.stdout.trim().split('|');
  return { id, platform: `${platformOs}/${architecture}`, digests: JSON.parse(digests) };
}

async function requireDockerObjectAbsent(kind, reference) {
  try {
    await runCapture('docker', [kind, 'inspect', reference]);
  } catch (error) {
    const detail = `${error.result?.stdout ?? ''}\n${error.result?.stderr ?? ''}`;
    if (/no such (image|container|object)/iu.test(detail)) return;
    throw new AcceptanceError(`could not safely establish absence of ${kind} ${reference}`);
  }
  throw new AcceptanceError(`temporary ${kind} already exists: ${reference}`);
}

async function liveProjectSnapshot() {
  const result = await runCapture('docker', [
    'ps', '--filter', 'label=com.docker.compose.project=quarangate', '--format', '{{.ID}}',
  ]);
  const ids = result.stdout.trim().split(/\s+/u).filter(Boolean).sort();
  if (ids.length === 0) throw new AcceptanceError('expected at least one running live QuaranGate container');
  const snapshot = [];
  for (const id of ids) {
    const inspected = await runCapture('docker', [
      'inspect', id, '--format',
      '{{index .Config.Labels "com.docker.compose.service"}}|{{.Id}}|{{.Image}}|{{.State.StartedAt}}',
    ]);
    const [service, containerId, imageId, startedAt] = inspected.stdout.trim().split('|');
    if (!service || !containerId || !imageId || !startedAt) {
      throw new AcceptanceError(`could not establish complete live QuaranGate container identity for ${id}`);
    }
    snapshot.push({ service, id: containerId, imageId, startedAt });
  }
  snapshot.sort((left, right) => `${left.service}|${left.id}`.localeCompare(`${right.service}|${right.id}`));
  return snapshot;
}

async function syntheticNpmMechanism(tempRoot) {
  const fixtureRoot = path.join(tempRoot, 'synthetic-npm');
  const packageTree = path.join(fixtureRoot, 'tar-input', 'package');
  const project = path.join(fixtureRoot, 'project');
  const cache = path.join(fixtureRoot, 'cache');
  const tarball = path.join(fixtureRoot, 'synthetic-offline-package-1.0.0.tgz');
  await fs.mkdir(packageTree, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(packageTree, 'package.json'), canonicalJson({
    name: 'synthetic-offline-package',
    version: '1.0.0',
    main: 'index.js',
    scripts: {
      install: 'node -e "require(\'node:fs\').writeFileSync(\'../../install-script-ran\',\'ran\')"',
    },
  }));
  await fs.writeFile(path.join(packageTree, 'index.js'), 'module.exports = { value: 42 };\n');
  await runCapture('tar', ['-czf', tarball, '-C', path.join(fixtureRoot, 'tar-input'), 'package']);
  const digest = createHash('sha512').update(await fs.readFile(tarball)).digest('base64');
  await fs.writeFile(path.join(project, 'package.json'), canonicalJson({
    name: 'synthetic-consumer',
    version: '1.0.0',
    private: true,
    dependencies: { 'synthetic-offline-package': '1.0.0' },
  }));
  await fs.writeFile(path.join(project, 'package-lock.json'), canonicalJson({
    name: 'synthetic-consumer',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'synthetic-consumer', version: '1.0.0',
        dependencies: { 'synthetic-offline-package': '1.0.0' },
      },
      'node_modules/synthetic-offline-package': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/synthetic-offline-package/-/synthetic-offline-package-1.0.0.tgz',
        integrity: `sha512-${digest}`,
        hasInstallScript: true,
      },
    },
  }));
  await runVisible('npm', ['cache', 'add', tarball, `--cache=${cache}`, '--offline', '--ignore-scripts']);
  await runVisible('npm', ['ci', `--cache=${cache}`, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: project });
  await runVisible('node', ['-e', "const p=require('synthetic-offline-package'); if(p.value!==42) process.exit(1)"], { cwd: project });
  try {
    await fs.lstat(path.join(project, 'install-script-ran'));
    throw new AcceptanceError('synthetic install lifecycle script executed');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return true;
}

async function copyBundle(source, destination) {
  await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

async function prepareOfflineValidationWorktree(head, bundlePath, tempRoot, sourceRoot) {
  const verifiedTarballs = path.join(tempRoot, 'host-verified-tarballs');
  const npmCache = path.join(tempRoot, 'host-npm-cache');
  await runVisible('git', ['worktree', 'add', '--detach', sourceRoot, head]);
  await runVisible(process.execPath, [
    path.resolve('scripts/npm-offline-bundle.mjs'), 'materialize',
    '--bundle', bundlePath,
    '--lockfile', path.join(sourceRoot, 'package-lock.json'),
    '--descriptor', path.join(sourceRoot, 'build/npm-dependencies.json'),
    '--destination', verifiedTarballs,
  ]);
  await fs.mkdir(npmCache, { recursive: true });
  const artifacts = (await fs.readdir(verifiedTarballs)).filter((name) => name.endsWith('.tgz')).sort();
  if (artifacts.length === 0) throw new AcceptanceError('verified bundle materialized no npm artifacts');
  for (const artifact of artifacts) {
    await runVisible('npm', [
      'cache', 'add', path.join(verifiedTarballs, artifact),
      `--cache=${npmCache}`, '--offline', '--ignore-scripts',
    ], { cwd: sourceRoot });
  }
  await runVisible('npm', [
    'ci', `--cache=${npmCache}`, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
  ], { cwd: sourceRoot });
  return sourceRoot;
}

async function composeValidation(bundlePath) {
  const safeEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: os.tmpdir(),
    INTERNAL_TOKEN: 'npm-offline-acceptance-placeholder-not-a-secret',
    DOCKER_AUTHORITY_TOKEN: 'npm-offline-acceptance-docker-authority-placeholder-not-a-secret',
    QUARANGATE_NPM_BUNDLE_PATH: bundlePath,
    GIT_REVISION: 'npm-offline-acceptance',
    GATEWAY_IMAGE: 'quarangate:npm-offline-acceptance-gateway-config-only',
    DOCKER_AUTHORITY_IMAGE: 'quarangate:npm-offline-acceptance-docker-authority-config-only',
    EXECUTOR_IMAGE: 'quarangate:npm-offline-acceptance-executor-config-only',
    AGENT_KIRO_KEY_FILE: '/tmp/npm-offline-acceptance-nonexistent-key',
  };
  const result = await runCapture('docker', ['compose', '--env-file', '/dev/null', 'config', '--format', 'json'], { env: safeEnv });
  const config = JSON.parse(result.stdout);
  const gateway = config.services?.gateway?.build;
  const executor = config.services?.executor?.build;
  const contextValue = (build) => build?.additional_contexts?.npm_deps ?? build?.additionalContexts?.npm_deps;
  if (contextValue(gateway) !== bundlePath || contextValue(executor) !== bundlePath) {
    throw new AcceptanceError('Compose npm_deps contexts do not resolve to the approved bundle');
  }
  if (gateway?.network !== 'none' || executor?.network !== 'none') {
    throw new AcceptanceError('Compose build network is not none for both services');
  }
  if (config.networks?.internal?.internal !== true || config.networks?.edge?.name !== 'quarangate-edge' ||
      config.networks?.internal?.name !== 'quarangate-internal') {
    throw new AcceptanceError('Compose runtime network definitions changed unexpectedly');
  }

  const runtimeEnv = { ...safeEnv };
  delete runtimeEnv.QUARANGATE_NPM_BUNDLE_PATH;
  const servicesResult = await runCapture(
    'docker', ['compose', '--env-file', '/dev/null', 'config', '--services'], { env: runtimeEnv },
  );
  const services = servicesResult.stdout.trim().split(/\s+/u).filter(Boolean).sort();
  if (services.join(',') !== 'docker-authority,executor,gateway') {
    throw new AcceptanceError('Compose services cannot be enumerated without QUARANGATE_NPM_BUNDLE_PATH');
  }
  await runCapture('docker', ['compose', '--env-file', '/dev/null', 'ps'], { env: runtimeEnv });

  const unsetResult = await runCapture(
    'docker', ['compose', '--env-file', '/dev/null', 'config', '--format', 'json'], { env: runtimeEnv },
  );
  const unsetConfig = JSON.parse(unsetResult.stdout);
  const unsetGatewayContext = contextValue(unsetConfig.services?.gateway?.build);
  const unsetExecutorContext = contextValue(unsetConfig.services?.executor?.build);
  const sentinelContext = path.resolve('build');
  if (unsetGatewayContext !== sentinelContext || unsetExecutorContext !== sentinelContext) {
    throw new AcceptanceError('unset Compose npm_deps context does not resolve to the fail-closed build sentinel');
  }
  return {
    gatewayContext: contextValue(gateway),
    executorContext: contextValue(executor),
    unsetGatewayContext,
    unsetExecutorContext,
    runtimeWithoutBundle: true,
    network: 'none',
  };
}

async function buildWithoutValidBundleRefused(head, imageTag, localBaseContext) {
  const combined = await expectFailure('docker', [
    'buildx', 'build', '--load', '--progress=plain', '--network=none', '--pull=false', '--no-cache',
    '--build-context', localBaseContext,
    '--build-context', `npm_deps=${path.resolve('build')}`, '--build-arg', `GIT_REVISION=${head}`,
    '-t', imageTag, '.',
  ], /STOP_BUNDLE_INVALID[\s\S]*bundle directory contains unexpected or missing entries/u);
  if (/npm (?:http|https)|https:\/\/registry\.npmjs\.org/iu.test(combined)) {
    throw new AcceptanceError('invalid-bundle build reached npm registry activity');
  }
  try { assertNoRegistryActivity(combined); }
  catch (error) { throw new AcceptanceError(error.message); }
  await requireDockerObjectAbsent('image', imageTag);
  return true;
}

async function runtimeImageValidation(image, containerName) {
  const script = [
    'set -eu',
    'tini_version=$(/sbin/tini --version 2>&1)',
    "tini_sha=$(sha256sum /sbin/tini | cut -d' ' -f1)",
    'test -d /app/dist/gateway',
    'test -d /app/dist/executor',
    'test -f /app/node_modules/express/package.json',
    'test -f /app/node_modules/@modelcontextprotocol/sdk/package.json',
    'test -f /app/node_modules/ollama/package.json',
    'test -f /app/node_modules/tar-stream/package.json',
    'test -f /app/node_modules/undici/package.json',
    'test -f /app/node_modules/yaml/package.json',
    'test -f /app/node_modules/zod/package.json',
    'test ! -e /app/src',
    'test ! -e /app/.git',
    'test ! -e /app/.env',
    'test ! -e /app/config',
    'test ! -e /npm-deps',
    "tgz_count=$(find /app /root /home/node -type f -name 'sha512-*.tgz' 2>/dev/null | wc -l)",
    "cache_count=$(find /app /root /home/node -type d -name _cacache 2>/dev/null | wc -l)",
    "logs_count=$(find /app /root /home/node -type d -name _logs 2>/dev/null | wc -l)",
    "npx_count=$(find /app /root /home/node -type d -name _npx 2>/dev/null | wc -l)",
    "npmrc_count=$(find /app /root /home/node -type f -name .npmrc 2>/dev/null | wc -l)",
    '[ "$tgz_count" -eq 0 ]',
    '[ "$cache_count" -eq 0 ]',
    '[ "$logs_count" -eq 0 ]',
    '[ "$npx_count" -eq 0 ]',
    '[ "$npmrc_count" -eq 0 ]',
    'printf "%s|%s|%s|%s|%s|%s|%s\\n" "$tini_version" "$tini_sha" "$tgz_count" "$cache_count" "$logs_count" "$npx_count" "$npmrc_count"',
  ].join('; ');
  const result = await runCapture('docker', [
    'run', '--rm', '--name', containerName, '--network=none', '--pull=never',
    '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges:true',
    '--user', '0:0', '--entrypoint', '/bin/sh', image, '-c', script,
  ]);
  const [tiniVersion, tiniSha256, tarballCount, cacheCount, logsCount, npxCount, npmrcCount] = result.stdout.trim().split('|');
  if (!tiniVersion.includes('0.19.0') || tiniSha256 !== EXPECTED_TINI_SHA256) {
    throw new AcceptanceError('runtime Tini verification failed');
  }
  return {
    tiniVersion, tiniSha256,
    runtimeBundleArtifactsPresent: Number(tarballCount) !== 0,
    runtimeNpmCachePresent: [cacheCount, logsCount, npxCount].some((count) => Number(count) !== 0),
    runtimeNpmrcPresent: Number(npmrcCount) !== 0,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = `${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `quarangate-npm-offline-acceptance-${runId}-`));
  const imageTag = `quarangate:npm-offline-acceptance-${runId}`;
  const invalidImageTag = `quarangate:npm-offline-acceptance-invalid-${runId}`;
  const smokeName = `quarangate-npm-offline-acceptance-smoke-${runId}`;
  let imageCreated = false;
  let createdImageId = null;
  let smokeAttempted = false;
  let validationWorktree = null;
  let localBaseTagged = false;
  let localBase = null;
  const summary = {
    verdict: 'FAIL',
    runId,
    checks: {},
    temporaryImage: imageTag,
    cleanup: {},
  };
  let primaryError = null;
  try {
    await requireDockerObjectAbsent('image', imageTag);
    await requireDockerObjectAbsent('image', invalidImageTag);
    await requireDockerObjectAbsent('container', smokeName);

    const head = (await runCapture('git', ['rev-parse', 'HEAD'])).stdout.trim();
    const lockBefore = await sha256File('package-lock.json');
    if (lockBefore !== EXPECTED_LOCK_SHA256) throw new AcceptanceError('canonical package-lock hash drift');
    const baseBefore = await dockerImageInfo(BASE_IMAGE);
    localBase = localBasePlan(baseBefore.id, runId);
    await requireDockerObjectAbsent('image', localBase.tempTag);
    await runCapture('docker', ['tag', baseBefore.id, localBase.tempTag]);
    localBaseTagged = true;
    const localBaseId = (await runCapture('docker', ['image', 'inspect', localBase.tempTag, '--format', '{{.Id}}'])).stdout.trim();
    if (localBaseId !== baseBefore.id) throw new AcceptanceError('temporary local base tag identity mismatch');
    const liveBefore = await liveProjectSnapshot();
    summary.head = head;
    summary.baseImageBefore = baseBefore;
    summary.localBase = { tag: localBase.tempTag, imageId: baseBefore.id, buildContext: localBase.buildContext };
    summary.liveBefore = liveBefore;

    if (options.prepare) {
      if (!options.artifactRoot) throw new AcceptanceError('--prepare requires --artifact-root');
      await runVisible(process.execPath, ['scripts/npm-offline-bundle.mjs', 'prepare', '--artifact-root', options.artifactRoot, '--json']);
    }
    let bundlePath = options.bundle;
    if (!bundlePath) {
      bundlePath = (await runCapture(process.execPath, [
        'scripts/npm-offline-bundle.mjs', 'print-path', '--artifact-root', options.artifactRoot,
      ])).stdout.trim();
    }
    summary.bundlePath = bundlePath;
    const verified = JSON.parse((await runCapture(process.execPath, [
      'scripts/npm-offline-bundle.mjs', 'verify', '--bundle', bundlePath, '--json',
    ])).stdout);
    summary.bundle = verified;
    summary.checks.N1_NORMAL = true;
    summary.checks.N11_NO_CREDENTIALS = true;

    await syntheticNpmMechanism(tempRoot);
    summary.checks.SYNTHETIC_NPM_MECHANISM = true;

    const wrongLock = path.join(tempRoot, 'wrong-package-lock.json');
    const wrongLockObject = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
    wrongLockObject.name = `${wrongLockObject.name}-wrong-lock`;
    await fs.writeFile(wrongLock, canonicalJson(wrongLockObject));
    await expectFailure(process.execPath, [
      'scripts/npm-offline-bundle.mjs', 'verify', '--bundle', bundlePath,
      '--lockfile', wrongLock, '--descriptor', 'build/npm-dependencies.json',
    ], /canonical lock-derived value|packageLockSha256/u);
    summary.checks.N2_WRONG_LOCK = true;

    const missingBundle = path.join(tempRoot, 'missing-bundle');
    await copyBundle(bundlePath, missingBundle);
    const tarballs = (await fs.readdir(path.join(missingBundle, 'tarballs'))).sort();
    await fs.unlink(path.join(missingBundle, 'tarballs', tarballs[0]));
    await expectFailure(process.execPath, [
      'scripts/npm-offline-bundle.mjs', 'verify', '--bundle', missingBundle,
    ], /unexpected or missing artifacts/u);
    summary.checks.N3_MISSING_ARTIFACT = true;

    const corruptBundle = path.join(tempRoot, 'corrupt-bundle');
    await copyBundle(bundlePath, corruptBundle);
    const corruptPath = path.join(corruptBundle, 'tarballs', tarballs[0]);
    const corruptBytes = await fs.readFile(corruptPath);
    corruptBytes[0] = corruptBytes[0] ^ 0xff;
    await fs.writeFile(corruptPath, corruptBytes);
    await expectFailure(process.execPath, [
      'scripts/npm-offline-bundle.mjs', 'verify', '--bundle', corruptBundle,
    ], /SHA-512 mismatch/u);
    summary.checks.N4_CORRUPTED_ARTIFACT = true;

    const compose = await composeValidation(bundlePath);
    summary.compose = compose;
    summary.checks.RUNTIME_COMPOSE_WITHOUT_BUNDLE = true;
    summary.checks.COMPOSE_CONFIG = true;
    await buildWithoutValidBundleRefused(head, invalidImageTag, localBase.buildContext);
    summary.checks.BUILD_WITHOUT_VALID_BUNDLE = 'REFUSED';

    await runVisible('git', ['diff', '--check']);
    validationWorktree = path.join(tempRoot, 'source-validation');
    await prepareOfflineValidationWorktree(head, bundlePath, tempRoot, validationWorktree);
    summary.checks.HOST_VALIDATION_OFFLINE_DEPS = true;
    await runVisible('npm', ['run', 'typecheck'], { cwd: validationWorktree });
    summary.checks.N7_TYPECHECK = true;
    const vitestJson = path.join(tempRoot, 'vitest.json');
    await runVisible('npm', ['test', '--', '--reporter=json', `--outputFile=${vitestJson}`], { cwd: validationWorktree });
    const testReport = JSON.parse(await fs.readFile(vitestJson, 'utf8'));
    const testFiles = Array.isArray(testReport.testResults) ? testReport.testResults : [];
    summary.unitTests = {
      files: testFiles.length,
      passedFiles: testFiles.filter((file) => file.status === 'passed').length,
      tests: testReport.numTotalTests,
      passedTests: testReport.numPassedTests,
    };
    if (summary.unitTests.files !== summary.unitTests.passedFiles || summary.unitTests.tests !== summary.unitTests.passedTests) {
      throw new AcceptanceError('unit test report contains failures');
    }
    summary.checks.N8_UNIT_TESTS = true;
    await runVisible('npm', ['run', 'build'], { cwd: validationWorktree });
    summary.checks.BUILD = true;

    const buildResult = await runVisibleCapture('docker', [
      'buildx', 'build', '--load', '--progress=plain', '--network=none', '--pull=false', '--no-cache',
      '--build-context', localBase.buildContext,
      '--build-context', `npm_deps=${bundlePath}`, '--build-arg', `GIT_REVISION=${head}`,
      '-t', imageTag, '.',
    ]);
    try { assertNoRegistryActivity(`${buildResult.stdout}\n${buildResult.stderr}`); }
    catch (error) { throw new AcceptanceError(error.message); }
    imageCreated = true;
    const built = await dockerImageInfo(imageTag);
    createdImageId = built.id;
    summary.temporaryImageId = built.id;
    summary.checks.N5_NETWORK_NONE_BUILD = true;
    summary.checks.N10_FRESH_DEPENDENCY_STATE = true;

    smokeAttempted = true;
    const runtime = await runtimeImageValidation(imageTag, smokeName);
    summary.runtime = runtime;
    const labelsResult = await runCapture('docker', [
      'image', 'inspect', imageTag, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "org.opencontainers.image.source"}}',
    ]);
    const [revision, source] = labelsResult.stdout.trim().split('|');
    if (revision !== head || source !== 'https://github.com/Herman940306/QuaranGate') {
      throw new AcceptanceError('OCI provenance labels do not match policy');
    }
    summary.oci = { revision, source };

    const baseAfter = await dockerImageInfo(BASE_IMAGE);
    if (baseAfter.id !== baseBefore.id) throw new AcceptanceError('base image ID changed during acceptance');
    summary.baseImageAfter = baseAfter;
    summary.checks.N6_NO_PULL = true;

    const lockAfter = await sha256File('package-lock.json');
    if (lockAfter !== lockBefore) throw new AcceptanceError('package-lock changed during acceptance');
    summary.packageLockSha256 = lockAfter;

    const liveAfter = await liveProjectSnapshot();
    summary.liveAfter = liveAfter;
    if (JSON.stringify(liveAfter) !== JSON.stringify(liveBefore)) {
      throw new AcceptanceError('live QuaranGate stack changed during acceptance');
    }
    summary.checks.N12_LIVE_STACK_UNCHANGED = true;
    summary.checks.N9_SOURCE_FREE_PREPARATION = true;
    summary.verdict = 'PASS';
  } catch (error) {
    primaryError = error;
    summary.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (localBaseTagged && localBase) {
      try {
        const taggedId = (await runCapture('docker', ['image', 'inspect', localBase.tempTag, '--format', '{{.Id}}'])).stdout.trim();
        if (taggedId !== localBase.imageId) throw new AcceptanceError('temporary local base tag changed ownership; refusing cleanup');
        await runCapture('docker', ['image', 'rm', localBase.tempTag]);
        summary.cleanup.localBaseTag = 'removed';
        localBaseTagged = false;
      } catch (error) {
        summary.cleanup.localBaseTag = `FAILED: ${error.message}`;
        if (!primaryError) primaryError = error;
        summary.verdict = 'FAIL';
      }
    } else {
      summary.cleanup.localBaseTag = 'not-created';
    }
    if (validationWorktree) {
      try {
        await runCapture('git', ['worktree', 'remove', '--force', validationWorktree]);
        summary.cleanup.validationWorktree = 'removed';
        validationWorktree = null;
      } catch (error) {
        summary.cleanup.validationWorktree = `FAILED: ${error.message}`;
        if (!primaryError) primaryError = error;
        summary.verdict = 'FAIL';
      }
    } else {
      summary.cleanup.validationWorktree = 'not-created';
    }
    if (smokeAttempted) {
      try {
        await runCapture('docker', ['rm', '-f', smokeName]);
        summary.cleanup.smokeContainer = 'removed';
      } catch {
        summary.cleanup.smokeContainer = 'absent';
      }
    } else {
      summary.cleanup.smokeContainer = 'not-created';
    }
    if (imageCreated) {
      try {
        const current = await dockerImageInfo(imageTag);
        if (current.id !== createdImageId) throw new AcceptanceError('temporary image tag changed ownership; refusing cleanup');
        await runCapture('docker', ['image', 'rm', imageTag]);
        summary.cleanup.temporaryImage = 'removed';
      } catch (error) {
        summary.cleanup.temporaryImage = `FAILED: ${error.message}`;
        if (!primaryError) primaryError = error;
        summary.verdict = 'FAIL';
      }
    } else {
      summary.cleanup.temporaryImage = 'not-created';
    }
    try {
      const invalidImage = await dockerImageInfo(invalidImageTag);
      await runCapture('docker', ['image', 'rm', invalidImageTag]);
      summary.cleanup.invalidBundleImage = `removed ${invalidImage.id}`;
    } catch (error) {
      const detail = `${error.result?.stdout ?? ''}\n${error.result?.stderr ?? ''}`;
      if (/no such image/iu.test(detail)) summary.cleanup.invalidBundleImage = 'absent';
      else {
        summary.cleanup.invalidBundleImage = `FAILED: ${error.message}`;
        if (!primaryError) primaryError = error;
        summary.verdict = 'FAIL';
      }
    }
    if (validationWorktree) {
      summary.cleanup.temporaryFixtures = `preserved:${tempRoot}`;
    } else {
      await fs.rm(tempRoot, { recursive: true, force: true });
      summary.cleanup.temporaryFixtures = 'removed';
    }
    process.stdout.write(`\nQUARANGATE_NPM_OFFLINE_ACCEPTANCE_JSON\n${canonicalJson(summary)}`);
  }
  if (primaryError) throw primaryError;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
