#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const HEX40 = /^[0-9a-f]{40}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const SAFE_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u;
const SOURCE_URL = 'https://github.com/Herman940306/QuaranGate';
const CORE_COMPONENTS = ['docker-authority', 'executor', 'gateway'];
const ALL_COMPONENTS = [...CORE_COMPONENTS, 'projects-work'];
const EXECUTABLE_PAYLOADS = new Set([
  'scripts/production-runtime-start.sh',
  'scripts/production-runtime-stop.sh',
]);
const SOURCE_PAYLOADS = [
  'compose.yaml',
  'package-lock.json',
  'package.json',
  'scripts/installer-bootstrap.mjs',
  'scripts/production-runtime-start.sh',
  'scripts/production-runtime-stop.sh',
  'scripts/windows/QuaranGate-Setup.cmd',
  'scripts/windows/QuaranGate-Setup.ps1',
  'scripts/windows/Inspect-QuaranGateProductionAutostart.ps1',
  'scripts/windows/Install-QuaranGateProductionAutostart.ps1',
  'scripts/windows/Open-QuaranGateControlCenter.ps1',
  'scripts/windows/Remove-QuaranGateProductionAutostart.ps1',
];
const CONTRACT_ENTRY_MODULES = [
  'dist/installer/productionRelease.js',
  'dist/installer/releasePackage.js',
];

function fail(message) {
  throw new Error(message);
}

function argMap(argv) {
  const out = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || out.has(key)) {
      fail('arguments must be unique --name value pairs');
    }
    out.set(key, value);
  }
  return out;
}

function required(args, name) {
  const value = args.get(name)?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function canonicalAbsolute(value, label) {
  if (!path.isAbsolute(value)) fail(`${label} must be absolute`);
  const resolved = path.resolve(value);
  if (resolved !== value || resolved === path.parse(resolved).root) fail(`${label} must be one canonical non-root absolute path`);
  return resolved;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function exactIsoUtc(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function releaseMaterialPlan(argv) {
  const args = argMap(argv);
  const sourceRoot = canonicalAbsolute(required(args, '--source-root'), '--source-root');
  const sourceCommit = required(args, '--source-commit');
  const coreImage = required(args, '--core-image');
  const projectsWorkSeedImage = required(args, '--projects-work-seed-image');
  const outputRoot = canonicalAbsolute(required(args, '--output-root'), '--output-root');
  const createdAt = required(args, '--created-at');

  if (!HEX40.test(sourceCommit)) fail('--source-commit must be 40 lowercase hex');
  if (!SAFE_IMAGE_REF.test(coreImage)) fail('--core-image has an invalid image reference');
  if (!SAFE_IMAGE_REF.test(projectsWorkSeedImage)) fail('--projects-work-seed-image has an invalid image reference');
  if (!exactIsoUtc(createdAt)) fail('--created-at must be one canonical UTC ISO timestamp with milliseconds');
  if (isWithin(sourceRoot, outputRoot)) fail('--output-root must remain outside the source worktree');

  const imageReferences = Object.fromEntries(ALL_COMPONENTS.map((component) => [
    component,
    `quarangate:${component}-${sourceCommit}`,
  ]));
  return { sourceRoot, sourceCommit, coreImage, projectsWorkSeedImage, outputRoot, createdAt, imageReferences };
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`${command} ${argv.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function dockerInspect(ref, format) {
  return run('docker', ['image', 'inspect', ref, '--format', format]);
}

function imageExists(ref) {
  const result = spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function requireImageId(ref, label) {
  const id = dockerInspect(ref, '{{.Id}}');
  if (!IMAGE_ID.test(id)) fail(`${label} did not resolve to an immutable image ID`);
  return id;
}

function assertCleanSource(plan) {
  if (!existsSync(plan.sourceRoot) || !lstatSync(plan.sourceRoot).isDirectory()
    || lstatSync(plan.sourceRoot).isSymbolicLink() || realpathSync(plan.sourceRoot) !== plan.sourceRoot) {
    fail('source root must be one real canonical non-symlink directory');
  }
  if (run('git', ['-C', plan.sourceRoot, 'rev-parse', 'HEAD']) !== plan.sourceCommit) fail('source HEAD does not match --source-commit');
  if (run('git', ['-C', plan.sourceRoot, 'status', '--porcelain']) !== '') fail('source worktree is not clean');
}

function validateCoreImage(plan) {
  const id = requireImageId(plan.coreImage, 'core image');
  const revision = dockerInspect(plan.coreImage, '{{index .Config.Labels "org.opencontainers.image.revision"}}');
  const source = dockerInspect(plan.coreImage, '{{index .Config.Labels "org.opencontainers.image.source"}}');
  if (revision !== plan.sourceCommit) fail('core image revision label does not match source commit');
  if (source !== SOURCE_URL) fail('core image source label does not match QuaranGate source');

  const probe = [
    'set -eu',
    '[ "$(id -u)" -ne 0 ]',
    'test "$(sha256sum /sbin/tini | cut -d" " -f1)" = 1358f1be32dc2a0dd8084dbda675c3b3dde8352b519b7b8a65573262551ad0fc',
    'test -r /app/package.json',
    'test "$(stat -c %a /app/package.json)" = "644"',
    'node -e "JSON.parse(require(\'node:fs\').readFileSync(\'/app/package.json\', \'utf8\'))"',
    'test -r /app/dist/gateway/index.js',
    'test -r /app/dist/executor/index.js',
    'test -r /app/dist/installer/cli.js',
    'test -r /app/dist/lifecycle/productionDriver.js',
    'test -r /app/console/app.js',
    'test -r /app/console/index.html',
    'test -r /app/node_modules/yaml/package.json',
    'test -r /app/node_modules/zod/package.json',
    'test ! -e /app/src',
    'test ! -e /app/.git',
    'test ! -e /app/.env',
    'test ! -e /npm-deps',
    'printf "CORE_RELEASE_IMAGE=PASS\\n"',
  ].join('; ');
  const stdout = run('docker', [
    'run', '--rm', '--pull=never', '--network', 'none', '--read-only',
    '--cap-drop=ALL', '--security-opt', 'no-new-privileges:true',
    '--entrypoint', '/bin/sh', id, '-ec', probe,
  ]);
  if (!stdout.split(/\r?\n/u).includes('CORE_RELEASE_IMAGE=PASS')) fail('core image runtime probe did not pass');
  return id;
}

function validateProjectsWorkSeed(plan) {
  const id = requireImageId(plan.projectsWorkSeedImage, 'projects-work seed image');
  const workingDir = dockerInspect(plan.projectsWorkSeedImage, '{{.Config.WorkingDir}}');
  if (workingDir !== '/workspace') fail(`projects-work seed WorkingDir mismatch: ${workingDir}`);
  const user = dockerInspect(plan.projectsWorkSeedImage, '{{.Config.User}}');
  if (!['node', '1000:1000', '1000'].includes(user)) fail(`projects-work seed User mismatch: ${user}`);
  const command = JSON.parse(dockerInspect(plan.projectsWorkSeedImage, '{{json .Config.Cmd}}'));
  if (JSON.stringify(command) !== JSON.stringify(['sh', '-c', 'while true; do sleep 3600; done'])) {
    fail(`projects-work seed Cmd mismatch: ${JSON.stringify(command)}`);
  }
  const layers = JSON.parse(dockerInspect(plan.projectsWorkSeedImage, '{{json .RootFS.Layers}}'));
  if (!Array.isArray(layers) || layers.length === 0) fail('projects-work seed has no rootfs layers');

  const probe = String.raw`set -eu
for tool in node npm npx git bash python3 grep find head; do command -v "$tool" >/dev/null; done
test "$(pwd)" = "/workspace"
test ! -S /var/run/docker.sock
printf 'PROJECTS_WORK_SEED=PASS\n'`;
  const stdout = run('docker', [
    'run', '--rm', '--pull=never', '--network', 'none', '--read-only',
    '--cap-drop=ALL', '--security-opt', 'no-new-privileges:true',
    '--entrypoint', 'sh', id, '-ec', probe,
  ]);
  if (!stdout.split(/\r?\n/u).includes('PROJECTS_WORK_SEED=PASS')) fail('projects-work seed runtime probe did not pass');
  if (requireImageId(plan.projectsWorkSeedImage, 'projects-work seed image') !== id) fail('projects-work seed identity changed during qualification');
  return { id, layers: layers.length, user, workingDir, command };
}

function ensureOutputRefsAbsent(plan) {
  for (const ref of Object.values(plan.imageReferences)) {
    if (imageExists(ref)) fail(`release image reference already exists: ${ref}`);
  }
}

function bindImageRefs(plan, coreImageId, projectsSeedId, createdRefs) {
  for (const component of CORE_COMPONENTS) {
    const ref = plan.imageReferences[component];
    run('docker', ['image', 'tag', coreImageId, ref]);
    createdRefs.push(ref);
    if (requireImageId(ref, `${component} release image`) !== coreImageId) fail(`${component} release image binding drifted`);
  }
  const projectsRef = plan.imageReferences['projects-work'];
  run('docker', ['image', 'tag', projectsSeedId, projectsRef]);
  createdRefs.push(projectsRef);
  if (requireImageId(projectsRef, 'projects-work release image') !== projectsSeedId) fail('projects-work release image binding drifted');
}

export function sourcePayloadFile(sourceRoot, relative) {
  const parts = relative.split('/');
  let current = sourceRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail(`source payload path contains a symbolic-link component: ${relative}`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail(`source payload parent is not a directory: ${relative}`);
    }
    if (index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1)) {
      fail(`source payload is not one regular non-linked file: ${relative}`);
    }
  }
  const real = realpathSync(current);
  if (!isWithin(sourceRoot, real)) fail(`source payload escapes source root: ${relative}`);
  return current;
}

function copySourcePayloads(sourceRoot, payloadRoot) {
  for (const relative of SOURCE_PAYLOADS) {
    const source = sourcePayloadFile(sourceRoot, relative);
    const target = path.join(payloadRoot, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
  }
}

function createCoreContainer(coreImageId) {
  return run('docker', ['create', '--network', 'none', '--entrypoint', '/bin/true', coreImageId]);
}

function dockerCopy(containerId, source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  run('docker', ['cp', `${containerId}:${source}`, destination]);
}

export function relativeRuntimeImports(relativeModule, sourceText) {
  const imports = new Set();
  const staticImport = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gu;
  for (const match of sourceText.matchAll(staticImport)) {
    const specifier = match[1];
    if (specifier.startsWith('node:')) continue;
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      fail(`release contract module has a non-builtin external import: ${relativeModule} -> ${specifier}`);
    }
    if (specifier.includes('\\') || specifier.includes('?') || specifier.includes('#')) {
      fail(`release contract module has an unsafe relative import: ${relativeModule} -> ${specifier}`);
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativeModule), specifier));
    if (!resolved.startsWith('dist/') || !resolved.endsWith('.js') || resolved.split('/').includes('..')) {
      fail(`release contract import escapes audited dist JavaScript: ${relativeModule} -> ${specifier}`);
    }
    imports.add(resolved);
  }
  return [...imports].sort();
}

function importRuntimeContract(coreImageId, scratchRoot) {
  const contractRoot = path.join(scratchRoot, 'contract');
  mkdirSync(contractRoot, { recursive: true, mode: 0o700 });
  const containerId = createCoreContainer(coreImageId);
  const copied = new Set();
  const queue = [...CONTRACT_ENTRY_MODULES];
  try {
    while (queue.length > 0) {
      const relative = queue.shift();
      if (copied.has(relative)) continue;
      const destination = path.join(contractRoot, ...relative.split('/'));
      dockerCopy(containerId, `/app/${relative}`, destination);
      copied.add(relative);
      const sourceText = readFileSync(destination, 'utf8');
      for (const dependency of relativeRuntimeImports(relative, sourceText)) {
        if (!copied.has(dependency)) queue.push(dependency);
      }
    }
  } finally {
    spawnSync('docker', ['rm', '-f', containerId], { stdio: 'ignore', shell: false });
  }
  return contractRoot;
}

async function runtimeContract(contractRoot) {
  const cache = `?release-material=${process.pid}-${Date.now()}`;
  const production = await import(`${pathToFileURL(path.join(contractRoot, 'dist/installer/productionRelease.js')).href}${cache}`);
  const releasePackage = await import(`${pathToFileURL(path.join(contractRoot, 'dist/installer/releasePackage.js')).href}${cache}`);
  return { production, releasePackage };
}

function copyRuntimePayload(coreImageId, payloadRoot, runtimeModules) {
  const containerId = createCoreContainer(coreImageId);
  try {
    for (const relative of runtimeModules) {
      dockerCopy(containerId, `/app/${relative}`, path.join(payloadRoot, ...relative.split('/')));
    }
    const modulesRoot = path.join(payloadRoot, 'node_modules');
    mkdirSync(modulesRoot, { recursive: true, mode: 0o700 });
    for (const packageName of ['yaml', 'zod']) {
      run('docker', ['cp', `${containerId}:/app/node_modules/${packageName}`, modulesRoot]);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', containerId], { stdio: 'ignore', shell: false });
  }
}

export function compareReleasePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeAndCollectPayload(root) {
  const files = [];
  const walk = (directory, prefix = '') => {
    chmodSync(directory, 0o700);
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`payload contains a symlink: ${relative}`);
      if (stat.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) fail(`payload contains an unsafe filesystem entry: ${relative}`);
      const mode = EXECUTABLE_PAYLOADS.has(relative) ? 0o755 : 0o644;
      chmodSync(absolute, mode);
      const bytes = readFileSync(absolute);
      files.push({
        path: relative.split(path.sep).join('/'),
        sizeBytes: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
        mode,
      });
    }
  };
  walk(root);
  files.sort((left, right) => compareReleasePaths(left.path, right.path));
  return files;
}

function writePrivateJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function removeCreatedRefs(refs) {
  for (const ref of [...refs].reverse()) {
    spawnSync('docker', ['image', 'rm', '-f', ref], { stdio: 'ignore', shell: false });
  }
}

export async function buildProductionReleaseMaterial(argv = process.argv.slice(2)) {
  const plan = releaseMaterialPlan(argv);
  const createdRefs = [];
  let outputCreated = false;
  try {
    assertCleanSource(plan);
    if (existsSync(plan.outputRoot)) fail('output root already exists');
    ensureOutputRefsAbsent(plan);

    const coreImageId = validateCoreImage(plan);
    const projectsSeed = validateProjectsWorkSeed(plan);
    bindImageRefs(plan, coreImageId, projectsSeed.id, createdRefs);

    mkdirSync(plan.outputRoot, { mode: 0o700 });
    outputCreated = true;
    chmodSync(plan.outputRoot, 0o700);
    const payloadRoot = path.join(plan.outputRoot, 'payload');
    const scratchRoot = path.join(plan.outputRoot, '.scratch');
    mkdirSync(payloadRoot, { mode: 0o700 });
    mkdirSync(scratchRoot, { mode: 0o700 });

    const contractRoot = importRuntimeContract(coreImageId, scratchRoot);
    const { production, releasePackage } = await runtimeContract(contractRoot);
    const runtimeModules = [...production.PRODUCTION_INSTALLER_RUNTIME_MODULES];
    const runtimePackages = [...production.PRODUCTION_INSTALLER_RUNTIME_PACKAGES];
    if (JSON.stringify(runtimePackages) !== JSON.stringify(['yaml', 'zod'])) fail('production runtime package contract drifted');

    copySourcePayloads(plan.sourceRoot, payloadRoot);
    copyRuntimePayload(coreImageId, payloadRoot, runtimeModules);
    const files = normalizeAndCollectPayload(payloadRoot);

    const packageJson = JSON.parse(readFileSync(path.join(plan.sourceRoot, 'package.json'), 'utf8'));
    if (typeof packageJson.version !== 'string') fail('source package version is missing');
    const images = [
      { component: 'docker-authority', reference: plan.imageReferences['docker-authority'], digest: coreImageId },
      { component: 'executor', reference: plan.imageReferences.executor, digest: coreImageId },
      { component: 'gateway', reference: plan.imageReferences.gateway, digest: coreImageId },
      { component: 'projects-work', reference: plan.imageReferences['projects-work'], digest: projectsSeed.id },
    ];

    const manifest = releasePackage.createReleasePackageManifest({
      schemaVersion: 1,
      productVersion: packageJson.version,
      sourceCommit: plan.sourceCommit,
      createdAt: plan.createdAt,
      architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
      signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
      lifecycle: {
        configSchemaVersion: 0,
        stateSchemaVersion: 0,
        components: [...ALL_COMPONENTS],
        migrations: [],
      },
      files,
      images,
    });
    production.verifyProductionReleaseProfile(manifest);
    production.verifyProductionReleasePayloadClosure(payloadRoot, manifest);
    const payloadVerification = releasePackage.verifyReleasePayload(
      manifest,
      (relative) => readFileSync(path.join(payloadRoot, ...relative.split('/'))),
    );

    rmSync(scratchRoot, { recursive: true, force: true });
    const manifestFile = path.join(plan.outputRoot, 'release-manifest.json');
    writePrivateJson(manifestFile, manifest);
    const manifestSha256 = sha256File(manifestFile);

    const receipt = {
      schemaVersion: 1,
      gate: 'p9-production-release-material',
      status: 'PASS',
      source: {
        commit: plan.sourceCommit,
        tree: run('git', ['-C', plan.sourceRoot, 'rev-parse', 'HEAD^{tree}']),
        clean: true,
      },
      release: {
        productVersion: manifest.productVersion,
        createdAt: manifest.createdAt,
        manifestDigest: manifest.manifestDigest,
        manifestSha256,
        payloadFiles: payloadVerification.verifiedFiles,
        payloadBytes: payloadVerification.verifiedBytes,
        signing: manifest.signing,
      },
      images: {
        coreInput: { reference: plan.coreImage, id: coreImageId },
        projectsWorkSeed: {
          reference: plan.projectsWorkSeedImage,
          id: projectsSeed.id,
          rootfsLayers: projectsSeed.layers,
          user: projectsSeed.user,
          workingDir: projectsSeed.workingDir,
        },
        release: images,
      },
      externalReleaseGates: {
        detachedEd25519SignatureProof: 'NOT_CREATED',
        installerTrustPolicy: 'NOT_CREATED',
        signedWindowsPackage: 'NOT_CREATED',
      },
    };
    const receiptFile = path.join(plan.outputRoot, 'release-material-receipt.json');
    writePrivateJson(receiptFile, receipt);

    if (run('git', ['-C', plan.sourceRoot, 'rev-parse', 'HEAD']) !== plan.sourceCommit
      || run('git', ['-C', plan.sourceRoot, 'status', '--porcelain']) !== '') {
      fail('source drifted while release material was assembled');
    }
    if (requireImageId(plan.coreImage, 'core image') !== coreImageId
      || requireImageId(plan.projectsWorkSeedImage, 'projects-work seed image') !== projectsSeed.id) {
      fail('input image identity drifted while release material was assembled');
    }

    return {
      ok: true,
      outputRoot: plan.outputRoot,
      payloadRoot,
      manifestFile,
      receiptFile,
      manifestDigest: manifest.manifestDigest,
      manifestSha256,
      payloadFiles: payloadVerification.verifiedFiles,
      payloadBytes: payloadVerification.verifiedBytes,
      images,
      signing: manifest.signing,
    };
  } catch (error) {
    if (outputCreated) rmSync(plan.outputRoot, { recursive: true, force: true });
    removeCreatedRefs(createdRefs);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  buildProductionReleaseMaterial().then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(`P9 production release material refused: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
