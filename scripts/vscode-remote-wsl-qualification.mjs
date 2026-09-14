#!/usr/bin/env node

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createEvidenceManifest,
  createQualificationStep,
  writeEvidenceManifest,
} from './vscode-qualification-evidence.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
export const QUALIFICATION_FIXTURE_ROOT = path.join(REPOSITORY_ROOT, 'tests', 'fixtures', 'vscode-qualification');
export const MAX_WORKSPACE_FILES = 256;
export const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024;

const SHA1 = /^[0-9a-f]{40}$/u;

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertSafeDisposableWorkspace(candidate) {
  const resolved = path.resolve(candidate);
  const tempRoot = path.resolve(os.tmpdir());
  const base = path.basename(resolved);
  const allowed = isInside(tempRoot, resolved) && base.startsWith('quarangate-vscode-qualification-');
  if (!allowed) throw new Error(`unsafe disposable workspace path refused: ${resolved}`);
  return resolved;
}

export function assertReadOnlyFixtureSeed(candidate) {
  const resolved = path.resolve(candidate);
  if (!isInside(QUALIFICATION_FIXTURE_ROOT, resolved)) {
    throw new Error(`fixture seed must be inside ${QUALIFICATION_FIXTURE_ROOT}`);
  }
  return resolved;
}

async function walkFiles(root) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`fixture/workspace symlink refused: ${relative}`);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push({ absolute, relative });
        if (files.length > MAX_WORKSPACE_FILES) throw new Error('workspace file count exceeds qualification bound');
      } else {
        throw new Error(`unsupported workspace entry: ${relative}`);
      }
    }
  }
  await walk(root);
  return files;
}

export async function computeWorkspaceIdentity(root) {
  const resolved = path.resolve(root);
  const files = await walkFiles(resolved);
  let totalBytes = 0;
  const entries = [];
  for (const file of files) {
    const bytes = await fs.readFile(file.absolute);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_WORKSPACE_BYTES) throw new Error('workspace bytes exceed qualification bound');
    entries.push({
      path: file.relative,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const content = `${entries.map((entry) => `${entry.sha256} ${entry.bytes} ${entry.path}`).join('\n')}\n`;
  return {
    root: resolved,
    fileCount: entries.length,
    totalBytes,
    entries,
    identitySha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

export function classifyWslEnvironment({ env = process.env, release = os.release() } = {}) {
  const distro = typeof env.WSL_DISTRO_NAME === 'string' ? env.WSL_DISTRO_NAME.trim() : '';
  const kernelIndicatesWsl = /microsoft|wsl/iu.test(release);
  if (!distro && !kernelIndicatesWsl) {
    return { result: 'BLOCKED_ENVIRONMENT', detail: { distro: null, kernelIndicatesWsl: false } };
  }
  return { result: 'PASS', detail: { distro: distro || null, kernelIndicatesWsl } };
}

export function evaluateRuntimeProbe(probe) {
  const step = (id, result, detail = {}, error = null) => createQualificationStep({ id, result, detail, error });
  const absent = (id) => step(id, 'NOT_RUN', { reason: 'live runtime observation not supplied' });
  const steps = [];

  if (!probe) {
    for (const id of [
      'vscode.remote_placement',
      'b4.runtime_binding',
      'b6.authenticated_session',
      'b5.workspace_identity',
      'workspace.drift',
      'vscode.model_api',
      'vscode.model_access',
      'review.execution',
      'review.cancellation',
      'transport.disconnect',
      'transport.backpressure',
      'reconnect.generation',
    ]) steps.push(absent(id));
    return steps;
  }

  const placement = probe.remotePlacement;
  if (!placement) steps.push(absent('vscode.remote_placement'));
  else {
    const pass = placement.extensionHostKind === 'workspace' && placement.remoteName === 'wsl';
    steps.push(step('vscode.remote_placement', pass ? 'PASS' : 'FAIL', {
      extensionHostKind: placement.extensionHostKind ?? null,
      remoteName: placement.remoteName ?? null,
    }));
  }

  const b4 = probe.b4RuntimeBinding;
  if (!b4) steps.push(absent('b4.runtime_binding'));
  else {
    const checks = {
      credentialOwnerVerified: b4.credentialOwnerVerified === true,
      credentialModeVerified: b4.credentialModeVerified === true,
      bindingMatches: b4.bindingMatches === true,
    };
    steps.push(step('b4.runtime_binding', Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', checks));
  }

  const b6 = probe.b6AuthenticatedSession;
  if (!b6) steps.push(absent('b6.authenticated_session'));
  else {
    const pass = b6.authenticated === true
      && typeof b6.sessionId === 'string' && b6.sessionId.length > 0
      && Number.isSafeInteger(b6.generation) && b6.generation >= 1;
    steps.push(step('b6.authenticated_session', pass ? 'PASS' : 'FAIL', {
      authenticated: b6.authenticated === true,
      sessionIdPresent: typeof b6.sessionId === 'string' && b6.sessionId.length > 0,
      generation: Number.isSafeInteger(b6.generation) ? b6.generation : null,
    }));
  }

  const b5 = probe.b5WorkspaceIdentity;
  if (!b5) steps.push(absent('b5.workspace_identity'));
  else {
    const checks = {
      workspaceMatched: b5.workspaceMatched === true,
      gitIdentityMatched: b5.gitIdentityMatched === true,
    };
    steps.push(step('b5.workspace_identity', Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', checks));
  }

  const drift = probe.workspaceDrift;
  if (!drift) steps.push(absent('workspace.drift'));
  else {
    const pass = drift.caseExecuted === true && drift.changedWorkspaceDenied === true && drift.handlerInvoked === false;
    steps.push(step('workspace.drift', pass ? 'PASS' : 'FAIL', {
      caseExecuted: drift.caseExecuted === true,
      changedWorkspaceDenied: drift.changedWorkspaceDenied === true,
      handlerInvoked: drift.handlerInvoked === true,
    }));
  }

  const modelApi = probe.modelApi;
  if (!modelApi) steps.push(absent('vscode.model_api'));
  else if (modelApi.publicApiAvailable === true) steps.push(step('vscode.model_api', 'PASS', { publicApiAvailable: true }));
  else if (modelApi.publicApiAvailable === false) steps.push(step('vscode.model_api', 'NOT_SUPPORTED', { publicApiAvailable: false }));
  else steps.push(step('vscode.model_api', 'FAIL', { reason: 'public API availability observation malformed' }));

  const modelAccess = probe.modelAccess;
  if (!modelAccess) steps.push(absent('vscode.model_access'));
  else {
    const state = modelAccess.state;
    const result = state === 'READY' ? 'PASS'
      : state === 'API_UNSUPPORTED' ? 'NOT_SUPPORTED'
        : ['CONSENT_REQUIRED', 'NO_SUPPORTED_MODEL', 'ACCESS_REVOKED', 'MODEL_UNAVAILABLE'].includes(state)
          ? 'BLOCKED_ENVIRONMENT'
          : 'FAIL';
    steps.push(step('vscode.model_access', result, { state: typeof state === 'string' ? state : null }));
  }

  const review = probe.reviewExecution;
  if (!review || review.attempted !== true) steps.push(absent('review.execution'));
  else {
    const pass = review.operationIdBound === true
      && review.boundedOutput === true
      && review.zeroWorkspaceMutation === true
      && review.terminalState === 'COMPLETED';
    steps.push(step('review.execution', pass ? 'PASS' : 'FAIL', {
      attempted: true,
      operationIdBound: review.operationIdBound === true,
      boundedOutput: review.boundedOutput === true,
      zeroWorkspaceMutation: review.zeroWorkspaceMutation === true,
      terminalState: review.terminalState ?? null,
    }));
  }

  const cancellation = probe.cancellation;
  if (!cancellation || cancellation.attempted !== true) steps.push(absent('review.cancellation'));
  else {
    const pass = cancellation.operationBound === true
      && cancellation.cancellationObserved === true
      && cancellation.lateOutputObserved === false
      && cancellation.settledOnce === true;
    steps.push(step('review.cancellation', pass ? 'PASS' : 'FAIL', {
      attempted: true,
      operationBound: cancellation.operationBound === true,
      cancellationObserved: cancellation.cancellationObserved === true,
      lateOutputObserved: cancellation.lateOutputObserved === true,
      settledOnce: cancellation.settledOnce === true,
    }));
  }

  const disconnect = probe.disconnect;
  if (!disconnect || disconnect.attempted !== true) steps.push(absent('transport.disconnect'));
  else {
    const pass = disconnect.falseSuccessObserved === false && disconnect.terminalState !== 'COMPLETED';
    steps.push(step('transport.disconnect', pass ? 'PASS' : 'FAIL', {
      attempted: true,
      falseSuccessObserved: disconnect.falseSuccessObserved === true,
      terminalState: disconnect.terminalState ?? null,
    }));
  }

  const backpressure = probe.backpressure;
  if (!backpressure || backpressure.attempted !== true) steps.push(absent('transport.backpressure'));
  else {
    const pass = backpressure.boundEnforced === true && backpressure.falseSuccessObserved === false;
    steps.push(step('transport.backpressure', pass ? 'PASS' : 'FAIL', {
      attempted: true,
      boundEnforced: backpressure.boundEnforced === true,
      falseSuccessObserved: backpressure.falseSuccessObserved === true,
    }));
  }

  const reconnect = probe.reconnectGeneration;
  if (!reconnect || reconnect.attempted !== true) steps.push(absent('reconnect.generation'));
  else {
    const pass = reconnect.generationAdvanced === true
      && reconnect.staleGenerationRejected === true
      && reconnect.staleOperationRejected === true;
    steps.push(step('reconnect.generation', pass ? 'PASS' : 'FAIL', {
      attempted: true,
      generationAdvanced: reconnect.generationAdvanced === true,
      staleGenerationRejected: reconnect.staleGenerationRejected === true,
      staleOperationRejected: reconnect.staleOperationRejected === true,
    }));
  }

  return steps;
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, ...options });
    let stdout = '';
    let stderr = '';
    const max = 16 * 1024;
    child.stdout?.on('data', (chunk) => { if (stdout.length < max) stdout += chunk.toString('utf8').slice(0, max - stdout.length); });
    child.stderr?.on('data', (chunk) => { if (stderr.length < max) stderr += chunk.toString('utf8').slice(0, max - stderr.length); });
    child.once('error', (error) => resolve({ code: null, signal: null, stdout, stderr, error }));
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr, error: null }));
  });
}

async function currentGitHead(root) {
  const result = await runCapture('git', ['rev-parse', 'HEAD'], { cwd: root });
  if (result.code !== 0) throw new Error('could not resolve qualification source commit');
  const sha = result.stdout.trim();
  if (!SHA1.test(sha)) throw new Error('qualification source commit is malformed');
  return sha;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!['--source-commit', '--fixture-seed', '--runtime-probe', '--output', '--run-id'].includes(token)) {
      throw new Error(`unsupported argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (values.has(token)) throw new Error(`duplicate argument: ${token}`);
    values.set(token, value);
    index += 1;
  }
  return {
    sourceCommit: values.get('--source-commit') ?? null,
    fixtureSeed: values.get('--fixture-seed') ?? path.join(QUALIFICATION_FIXTURE_ROOT, 'workspace-seed'),
    runtimeProbe: values.get('--runtime-probe') ?? null,
    output: values.get('--output') ?? null,
    runId: values.get('--run-id') ?? `vscode-qualification-${Date.now()}`,
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'));
}

export async function buildQualificationEvidence(options = {}) {
  const expectedSource = options.sourceCommit ?? await currentGitHead(REPOSITORY_ROOT);
  if (!SHA1.test(expectedSource)) throw new Error('expected source commit must be a 40-character lowercase Git SHA');
  const actualSource = await currentGitHead(REPOSITORY_ROOT);
  const fixtureSeed = assertReadOnlyFixtureSeed(options.fixtureSeed ?? path.join(QUALIFICATION_FIXTURE_ROOT, 'workspace-seed'));
  const fixtureIdentity = await computeWorkspaceIdentity(fixtureSeed);
  const wsl = classifyWslEnvironment(options.environment ?? undefined);
  const observedAt = new Date().toISOString();
  const steps = [
    createQualificationStep({
      id: 'source.commit',
      result: actualSource === expectedSource ? 'PASS' : 'FAIL',
      observedAt,
      detail: { expectedSource, actualSource },
    }),
    createQualificationStep({ id: 'environment.wsl', result: wsl.result, observedAt, detail: wsl.detail }),
    createQualificationStep({
      id: 'fixture.seed_identity',
      result: 'PASS',
      observedAt,
      detail: {
        fileCount: fixtureIdentity.fileCount,
        totalBytes: fixtureIdentity.totalBytes,
        identitySha256: fixtureIdentity.identitySha256,
      },
    }),
    ...evaluateRuntimeProbe(options.runtimeProbe ?? null),
  ];

  return createEvidenceManifest({
    sourceCommit: actualSource,
    runId: options.runId ?? `vscode-qualification-${Date.now()}`,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      liveQualificationExecuted: false,
    },
    steps,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeProbe = args.runtimeProbe ? await readJson(args.runtimeProbe) : null;
  const manifest = await buildQualificationEvidence({
    sourceCommit: args.sourceCommit,
    fixtureSeed: args.fixtureSeed,
    runtimeProbe,
    runId: args.runId,
  });
  if (args.output) {
    await writeEvidenceManifest(args.output, manifest);
    process.stdout.write(`VSCODE_QUALIFICATION_EVIDENCE=${path.resolve(args.output)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`VSCODE_REMOTE_WSL_QUALIFICATION=FAIL ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
