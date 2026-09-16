#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SHA1 = /^[0-9a-f]{40}$/u;
const SUPPORTED_GATES = Object.freeze(['typecheck', 'build', 'unit', 'integration', 'e2e', 'authority-invariants', 'sbom']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} is malformed JSON`); }
}

function run(binary, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    status: result.status,
    signal: result.signal ?? null,
    errorCode: result.error?.code ?? null,
    errorMessage: result.error?.message ?? null,
    durationMs: Date.now() - started,
    stdout,
    stderr,
  };
}

function git(args) {
  const result = run('git', args);
  if (result.errorCode || result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

export function validateSourceBindingReceipt(receipt) {
  const source = receipt?.source;
  if (receipt?.schemaVersion !== 1 || receipt?.gate !== 'source-binding' || receipt?.status !== 'PASS'
    || source?.clean !== true || !SHA1.test(source?.commit ?? '') || !SHA1.test(source?.tree ?? '')) {
    throw new Error('source-binding receipt is not a valid exact clean source receipt');
  }
  return source;
}

export function parseVitestReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.success !== true
    || !Number.isInteger(report.numTotalTests) || report.numTotalTests <= 0
    || !Number.isInteger(report.numFailedTests) || report.numFailedTests !== 0
    || !Number.isInteger(report.numPendingTests) || report.numPendingTests !== 0
    || !Number.isInteger(report.numTodoTests) || report.numTodoTests !== 0
    || !Array.isArray(report.testResults) || report.testResults.length <= 0
    || report.testResults.some((entry) => entry?.status !== 'passed')) {
    throw new Error('Vitest report is not an exact all-passing, no-skip/no-todo report');
  }
  return { files: report.testResults.length, tests: report.numTotalTests, failed: report.numFailedTests };
}

export function executionEvidence(result, commandId) {
  return {
    commandId,
    exitCode: result.status,
    signal: result.signal,
    durationMs: result.durationMs,
    stdout: { sha256: sha256(Buffer.from(result.stdout, 'utf8')), bytes: Buffer.byteLength(result.stdout, 'utf8') },
    stderr: { sha256: sha256(Buffer.from(result.stderr, 'utf8')), bytes: Buffer.byteLength(result.stderr, 'utf8') },
  };
}

function currentSource() {
  const commit = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const indexTree = git(['write-tree']);
  if (!SHA1.test(commit) || !SHA1.test(tree) || indexTree !== tree) throw new Error('current Git source/index identity is invalid or staged');
  const tracked = run('git', ['diff', '--quiet', '--no-ext-diff']);
  const staged = run('git', ['diff', '--cached', '--quiet', '--no-ext-diff']);
  const diffCheck = run('git', ['diff', '--check', 'HEAD']);
  if (tracked.status !== 0 || staged.status !== 0 || diffCheck.status !== 0) throw new Error('current Git working tree is not clean');
  const untrackedRaw = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (untrackedRaw.split('\0').filter(Boolean).length) throw new Error('current Git working tree has non-ignored untracked bytes');
  const originResult = run('git', ['config', '--get', 'remote.origin.url']);
  const branchResult = run('git', ['branch', '--show-current']);
  return {
    repository: originResult.status === 0 ? originResult.stdout.trim() || null : null,
    branch: branchResult.status === 0 ? branchResult.stdout.trim() || null : null,
    commit,
    tree,
    clean: true,
  };
}

function sameSource(a, b) {
  return a?.clean === true && b?.clean === true && a?.repository === b?.repository && a?.branch === b?.branch && a?.commit === b?.commit && a?.tree === b?.tree;
}

export function pathIsWithinRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

function requireExternalEvidencePath(path, label) {
  const worktreeRoot = git(['rev-parse', '--show-toplevel']);
  if (pathIsWithinRoot(worktreeRoot, path)) throw new Error(`${label} must be outside the Git worktree`);
}

function packageVersion(name) {
  const path = resolve('node_modules', name, 'package.json');
  if (!existsSync(path)) throw new Error(`required local package is unavailable: ${name}`);
  const value = readJson(path, `${name} package metadata`);
  if (typeof value.version !== 'string' || !value.version) throw new Error(`required local package version is invalid: ${name}`);
  return value.version;
}

export function integrationPrerequisites({ env = process.env, exists = existsSync, probeDocker = () => run('docker', ['version']) } = {}) {
  const missing = [];
  const keysEnv = env.KEYS_ENV;
  if (!keysEnv) missing.push('KEYS_ENV_NOT_CONFIGURED');
  else if (!exists(keysEnv)) missing.push('KEYS_ENV_NOT_FOUND');
  const docker = probeDocker();
  if (docker?.errorCode === 'ENOENT') missing.push('DOCKER_CLI_UNAVAILABLE');
  else if (docker?.errorCode || docker?.status !== 0) missing.push('DOCKER_RUNTIME_UNAVAILABLE');
  return missing;
}

export function vitestGateInvocation(definition, reportPath) {
  if (!definition?.vitest || typeof definition.scope !== 'string' || !definition.scope) {
    throw new Error('Vitest gate definition is invalid');
  }
  if (typeof reportPath !== 'string' || !reportPath) throw new Error('Vitest report path is required');
  return {
    binary: process.execPath,
    args: ['scripts/run-vitest-clean.mjs', definition.scope, '--no-file-parallelism', '--reporter=json', `--outputFile=${reportPath}`],
  };
}

export function gateDefinition(gate) {
  if (!SUPPORTED_GATES.includes(gate)) throw new Error(`unsupported fixed release gate: ${gate}`);
  if (gate === 'e2e') return { unavailable: true, reason: 'CANONICAL_E2E_ENTRYPOINT_NOT_INTEGRATED' };
  if (gate === 'typecheck') return { binary: resolve('node_modules/.bin/tsc'), args: ['-p', 'tsconfig.json', '--noEmit'], tool: { name: 'typescript', version: packageVersion('typescript') }, commandId: 'typescript-typecheck' };
  if (gate === 'build') return { binary: resolve('node_modules/.bin/tsc'), args: ['-p', 'tsconfig.json'], tool: { name: 'typescript', version: packageVersion('typescript') }, commandId: 'typescript-build' };
  if (gate === 'unit') return { vitest: true, scope: 'tests/unit', tool: { name: 'vitest', version: packageVersion('vitest') }, commandId: 'vitest-unit' };
  if (gate === 'integration') return { vitest: true, scope: 'tests/integration', tool: { name: 'vitest', version: packageVersion('vitest') }, commandId: 'vitest-integration' };
  if (gate === 'authority-invariants') return { binary: process.execPath, args: ['scripts/security-invariants.mjs'], tool: { name: 'quarangate-security-invariants', version: '1' }, commandId: 'authority-invariants' };
  return { sbom: true, binary: process.execPath, tool: { name: 'quarangate-release-sbom', version: '2' }, commandId: 'release-sbom' };
}

function writeReceipt(output, receipt) {
  if (output) writeFileSync(resolve(output), `${JSON.stringify(receipt, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

export function unavailableReceipt(gate, source, definition) {
  return {
    schemaVersion: 1,
    gate,
    status: 'UNAVAILABLE',
    source,
    failureCode: definition.reason,
    ...(Array.isArray(definition.missingPrerequisites) ? { missingPrerequisites: [...definition.missingPrerequisites].sort() } : {}),
  };
}

export function main(argv = process.argv.slice(2)) {
  const valueAfter = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const gate = valueAfter('--gate');
  const sourceBindingPath = valueAfter('--source-binding');
  const output = valueAfter('--output');
  const artifactOutput = valueAfter('--artifact-output');
  if (!gate) throw new Error('--gate is required');
  if (!sourceBindingPath || !existsSync(sourceBindingPath)) throw new Error('--source-binding requires an existing receipt');
  if (!output) throw new Error('--output is required');
  requireExternalEvidencePath(output, '--output');
  if (artifactOutput) requireExternalEvidencePath(artifactOutput, '--artifact-output');
  const source = validateSourceBindingReceipt(readJson(sourceBindingPath, 'source-binding receipt'));
  const before = currentSource();
  if (!sameSource(source, before)) throw new Error('source-binding receipt does not match current exact Git source');
  let definition = gateDefinition(gate);
  if (gate === 'integration') {
    const missingPrerequisites = integrationPrerequisites();
    if (missingPrerequisites.length) {
      definition = { ...definition, unavailable: true, reason: 'INTEGRATION_PREREQUISITES_UNAVAILABLE', missingPrerequisites };
    }
  }
  if (definition.unavailable) {
    writeReceipt(output, unavailableReceipt(gate, source, definition));
    return 4;
  }

  const temp = mkdtempSync(join(tmpdir(), 'qg-release-gate-'));
  try {
    let result;
    let testCounts;
    let artifact;
    if (definition.vitest) {
      const reportPath = join(temp, 'vitest.json');
      const invocation = vitestGateInvocation(definition, reportPath);
      result = run(invocation.binary, invocation.args);
      if (result.status === 0 && existsSync(reportPath)) testCounts = parseVitestReport(readJson(reportPath, 'Vitest report'));
    } else if (definition.sbom) {
      if (!artifactOutput) throw new Error('--artifact-output is required for sbom gate');
      const artifactPath = resolve(artifactOutput);
      result = run(definition.binary, ['scripts/release-sbom.mjs', '--output', artifactPath]);
      if (result.status === 0 && existsSync(artifactPath)) {
        const bytes = readFileSync(artifactPath);
        const doc = JSON.parse(bytes.toString('utf8'));
        if (doc.spdxVersion !== 'SPDX-2.3' || doc.SPDXID !== 'SPDXRef-DOCUMENT') throw new Error('generated SBOM is not SPDX-2.3');
        artifact = { kind: 'spdx-json', sha256: sha256(bytes), bytes: bytes.length };
      }
    } else {
      if (!existsSync(definition.binary) && definition.binary !== process.execPath) throw new Error(`fixed gate executable is unavailable: ${definition.commandId}`);
      result = run(definition.binary, definition.args);
      if (gate === 'authority-invariants' && result.status === 0) {
        const parsed = JSON.parse(result.stdout);
        if (parsed?.ok !== true || !Number.isInteger(parsed.rulesChecked) || parsed.rulesChecked <= 0 || !Array.isArray(parsed.failures) || parsed.failures.length !== 0) {
          throw new Error('authority invariant output is not an exact PASS report');
        }
        artifact = { rulesChecked: parsed.rulesChecked, composeFilesChecked: parsed.composeFilesChecked, dockerfilesChecked: parsed.dockerfilesChecked };
      }
    }

    const after = currentSource();
    if (!sameSource(source, after)) throw new Error('release gate mutated or drifted exact Git source');
    const status = result.status === 0 && !result.errorCode && (definition.vitest ? Boolean(testCounts) : true) && (definition.sbom ? Boolean(artifact) : true) ? 'PASS' : 'FAIL';
    const receipt = {
      schemaVersion: 1,
      gate,
      status,
      source,
      tool: definition.tool,
      execution: executionEvidence(result, definition.commandId),
      ...(testCounts ? { testCounts } : {}),
      ...(artifact ? { artifact } : {}),
      ...(status === 'FAIL' ? { failureCode: result.errorCode ? 'EXECUTION_ERROR' : 'COMMAND_FAILED' } : {}),
    };
    writeReceipt(output, receipt);
    return status === 'PASS' ? 0 : 5;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) process.exitCode = main();
