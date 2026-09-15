import { describe, expect, it } from 'vitest';
import { mkdtemp, cp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_EVIDENCE_INPUT_BYTES,
  createEvidenceManifest,
  createQualificationStep,
  readEvidenceInputJson,
  sanitizeEvidence,
  writeEvidenceManifest,
} from '../../scripts/cursor-qualification-evidence.mjs';
import {
  MAX_RUNTIME_PROBE_BYTES,
  QUALIFICATION_FIXTURE_ROOT,
  assertReadOnlyFixtureSeed,
  assertSafeDisposableWorkspace,
  buildQualificationEvidence,
  classifyWslEnvironment,
  computeWorkspaceIdentity,
  evaluateRuntimeProbe,
  readRuntimeProbeJson,
} from '../../scripts/cursor-remote-wsl-qualification.mjs';

const SOURCE = 'f1432e63a7ff2e315fbc0738a26c81b818bd4904';
const SEED = path.join(QUALIFICATION_FIXTURE_ROOT, 'workspace-seed');

describe('P7 I3 Cursor qualification infrastructure', () => {
  it('keeps PASS/FAIL/BLOCKED/NOT_SUPPORTED/NOT_RUN distinct', () => {
    const results = ['PASS', 'FAIL', 'BLOCKED_ENVIRONMENT', 'NOT_SUPPORTED', 'NOT_RUN'] as const;
    const steps = results.map((result, index) => createQualificationStep({
      id: `result.${index}`,
      result,
      observedAt: '2026-09-14T00:00:00.000Z',
    }));
    expect(steps.map((step) => step.result)).toEqual(results);
  });

  it('redacts sensitive raw material and bounds oversized strings', () => {
    const sanitized = sanitizeEvidence({
      accessToken: 'bearer-secret',
      credential: 'credential-secret',
      prompt: 'do something private',
      rawResponse: 'provider-private-body',
      operationId: 'op_safe',
      note: 'x'.repeat(10_000),
    }) as Record<string, unknown>;
    expect(sanitized.accessToken).toBe('[REDACTED]');
    expect(sanitized.credential).toBe('[REDACTED]');
    expect(sanitized.prompt).toBe('[REDACTED]');
    expect(sanitized.rawResponse).toBe('[REDACTED]');
    expect(sanitized.operationId).toBe('op_safe');
    expect(Buffer.byteLength(String(sanitized.note), 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('sanitizes object evidence into a null-prototype container', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    const sanitized = sanitizeEvidence(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect(sanitized.safe).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('records immutable source identity and rejects duplicate step ids', () => {
    const step = createQualificationStep({
      id: 'source.commit', result: 'PASS', observedAt: '2026-09-14T00:00:00.000Z',
    });
    const manifest = createEvidenceManifest({
      sourceCommit: SOURCE,
      runId: 'test-run',
      generatedAt: '2026-09-14T00:00:01.000Z',
      steps: [step],
    });
    expect(manifest.sourceCommit).toBe(SOURCE);
    expect(manifest.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => createEvidenceManifest({ sourceCommit: SOURCE, runId: 'dup', steps: [step, step] })).toThrow(/duplicate step/u);
  });

  it('revalidates direct manifest step inputs instead of trusting caller-supplied result values', () => {
    expect(() => createEvidenceManifest({
      sourceCommit: SOURCE,
      runId: 'invalid-direct-step',
      steps: [{ id: 'direct.invalid', result: 'MAYBE', observedAt: '2026-09-14T00:00:00.000Z' }],
    })).toThrow(/invalid qualification result/u);
  });

  it('confines evidence input/output to canonical qualification temp roots and preserves 0600 exclusive output', async () => {
    const safeRoot = await mkdtemp(path.join(os.tmpdir(), 'quarangate-cursor-qualification-'));
    const input = path.join(safeRoot, 'evidence-input.json');
    await writeFile(input, JSON.stringify({ sourceCommit: SOURCE, runId: 'safe-io', steps: [{ id: 'safe.io', result: 'PASS' }] }), 'utf8');
    await expect(readEvidenceInputJson(input)).resolves.toMatchObject({ runId: 'safe-io' });

    const manifest = createEvidenceManifest({
      sourceCommit: SOURCE,
      runId: 'safe-output',
      generatedAt: '2026-09-14T00:00:01.000Z',
      steps: [createQualificationStep({ id: 'safe.output', result: 'PASS', observedAt: '2026-09-14T00:00:00.000Z' })],
    });
    const output = path.join(safeRoot, 'evidence-output.json');
    await expect(writeEvidenceManifest(output, manifest)).resolves.toBe(output);
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ sourceCommit: SOURCE, runId: 'safe-output' });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(writeEvidenceManifest(output, manifest)).rejects.toThrow();

    await expect(writeEvidenceManifest(path.join(process.cwd(), 'should-not-write.json'), manifest))
      .rejects.toThrow(/qualification artifact/u);
    await expect(readEvidenceInputJson(path.join(process.cwd(), 'package.json'))).rejects.toThrow(/qualification artifact/u);
  });

  it('bounds the standalone evidence JSON input before parsing', async () => {
    const safeRoot = await mkdtemp(path.join(os.tmpdir(), 'quarangate-cursor-qualification-'));
    const oversized = path.join(safeRoot, 'oversized-evidence.json');
    await writeFile(oversized, JSON.stringify({ padding: 'x'.repeat(MAX_EVIDENCE_INPUT_BYTES + 1) }), 'utf8');
    await expect(readEvidenceInputJson(oversized)).rejects.toThrow(/byte bound/u);
  });

  it('accepts only fixture seeds under the authorized fixture convention', () => {
    expect(assertReadOnlyFixtureSeed(SEED)).toBe(path.resolve(SEED));
    expect(() => assertReadOnlyFixtureSeed(process.cwd())).toThrow(/fixture seed must be inside/u);
  });

  it('refuses canonical or valuable repository paths as disposable workspaces', () => {
    expect(() => assertSafeDisposableWorkspace(process.cwd())).toThrow(/unsafe disposable workspace/u);
    expect(() => assertSafeDisposableWorkspace('/workspace/QuaranGate-project-control')).toThrow(/unsafe disposable workspace/u);
    expect(() => assertSafeDisposableWorkspace('/workspace/QuaranGate-u1-full')).toThrow(/unsafe disposable workspace/u);
  });

  it('allows only explicitly named temporary disposable workspaces', async () => {
    const safe = await mkdtemp(path.join(os.tmpdir(), 'quarangate-cursor-qualification-'));
    expect(assertSafeDisposableWorkspace(safe)).toBe(path.resolve(safe));
    const generic = await mkdtemp(path.join(os.tmpdir(), 'random-workspace-'));
    expect(() => assertSafeDisposableWorkspace(generic)).toThrow(/unsafe disposable workspace/u);
  });

  it('rejects a prefixed disposable-workspace root that aliases another directory through a symlink', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'qg-qualification-target-'));
    const holder = await mkdtemp(path.join(os.tmpdir(), 'qg-qualification-holder-'));
    const alias = path.join(holder, 'quarangate-cursor-qualification-alias');
    await symlink(target, alias, 'dir');
    expect(() => assertSafeDisposableWorkspace(alias)).toThrow(/symbolic-link\/alias root/u);
  });

  it('computes deterministic bounded workspace identity and detects drift', async () => {
    const baseline = await computeWorkspaceIdentity(SEED);
    const temp = await mkdtemp(path.join(os.tmpdir(), 'quarangate-cursor-qualification-'));
    await cp(SEED, temp, { recursive: true });
    const copied = await computeWorkspaceIdentity(temp);
    expect(copied.identitySha256).toBe(baseline.identitySha256);
    await writeFile(path.join(temp, 'src', 'review-target.txt'), 'qualification fixture drift\n', 'utf8');
    const drifted = await computeWorkspaceIdentity(temp);
    expect(drifted.identitySha256).not.toBe(baseline.identitySha256);
  });

  it('classifies WSL evidence without pretending a non-WSL host is qualified', () => {
    expect(classifyWslEnvironment({ env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' }, release: 'linux' }).result).toBe('PASS');
    expect(classifyWslEnvironment({ env: {}, release: '6.8.0-generic' }).result).toBe('BLOCKED_ENVIRONMENT');
  });

  it('bounds runtime-probe JSON input and refuses oversized evidence input', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'quarangate-cursor-qualification-'));
    const valid = path.join(temp, 'runtime-probe.json');
    await writeFile(valid, JSON.stringify({ modelAccess: { state: 'CONSENT_REQUIRED' } }), 'utf8');
    await expect(readRuntimeProbeJson(valid)).resolves.toMatchObject({ modelAccess: { state: 'CONSENT_REQUIRED' } });

    const oversized = path.join(temp, 'oversized-probe.json');
    await writeFile(oversized, JSON.stringify({ padding: 'x'.repeat(MAX_RUNTIME_PROBE_BYTES + 1) }), 'utf8');
    await expect(readRuntimeProbeJson(oversized)).rejects.toThrow(/byte bound/u);
  });

  it('keeps absent live runtime probes explicitly NOT_RUN', () => {
    const steps = evaluateRuntimeProbe(null);
    expect(steps.length).toBeGreaterThan(5);
    expect(new Set(steps.map((step) => step.result))).toEqual(new Set(['NOT_RUN']));
  });

  it('preserves runtime probe result classifications without elevating blocked evidence', () => {
    const steps = evaluateRuntimeProbe({
      remotePlacement: { extensionHostKind: 'workspace', remoteName: 'wsl' },
      modelAccess: { state: 'CONSENT_REQUIRED' },
    });
    expect(steps.find((step) => step.id === 'cursor.remote_placement')?.result).toBe('PASS');
    expect(steps.find((step) => step.id === 'cursor.model_access')?.result).toBe('BLOCKED_ENVIRONMENT');
    expect(steps.find((step) => step.id === 'review.execution')?.result).toBe('NOT_RUN');
    expect(steps.find((step) => step.id === 'restart.recovery')?.result).toBe('NOT_RUN');
  });

  it('refuses contradictory review/cancellation PASS claims unless the complete live Cursor public-API prerequisite chain is proven', () => {
    const claimedReview = { attempted: true, operationIdBound: true, boundedOutput: true, zeroWorkspaceMutation: true, terminalState: 'COMPLETED' };
    const claimedCancel = { attempted: true, operationBound: true, cancellationObserved: true, lateOutputObserved: false, settledOnce: true };
    const contradictory = evaluateRuntimeProbe({
      productIdentity: { appName: 'Cursor', uriScheme: 'cursor', cursorExtensionApi: true },
      remotePlacement: { extensionHostKind: 'workspace', remoteName: 'wsl' },
      b4RuntimeBinding: { credentialOwnerVerified: true, credentialModeVerified: true, bindingMatches: true },
      b6AuthenticatedSession: { authenticated: true, sessionId: 'ides_fixture', generation: 1 },
      b5WorkspaceIdentity: { workspaceMatched: true, gitIdentityMatched: true },
      chatApi: { publicApiAvailable: false },
      modelApi: { publicApiAvailable: false },
      modelAccess: { state: 'API_UNSUPPORTED' },
      reviewExecution: claimedReview,
      cancellation: claimedCancel,
    });
    expect(contradictory.find((step) => step.id === 'review.execution')).toMatchObject({ result: 'FAIL', detail: { prerequisitesSatisfied: false } });
    expect(contradictory.find((step) => step.id === 'review.cancellation')).toMatchObject({ result: 'FAIL', detail: { prerequisitesSatisfied: false } });

    const coherent = evaluateRuntimeProbe({
      productIdentity: { appName: 'Cursor', uriScheme: 'cursor', cursorExtensionApi: true },
      remotePlacement: { extensionHostKind: 'workspace', remoteName: 'wsl' },
      b4RuntimeBinding: { credentialOwnerVerified: true, credentialModeVerified: true, bindingMatches: true },
      b6AuthenticatedSession: { authenticated: true, sessionId: 'ides_fixture', generation: 1 },
      b5WorkspaceIdentity: { workspaceMatched: true, gitIdentityMatched: true },
      chatApi: { publicApiAvailable: true },
      modelApi: { publicApiAvailable: true },
      modelAccess: { state: 'READY' },
      reviewExecution: claimedReview,
      cancellation: claimedCancel,
    });
    expect(coherent.find((step) => step.id === 'review.execution')?.result).toBe('PASS');
    expect(coherent.find((step) => step.id === 'review.cancellation')?.result).toBe('PASS');
  });

  it('records executor restart/recovery only when every conservative recovery property is proven', () => {
    const good = evaluateRuntimeProbe({
      restartRecovery: {
        attempted: true, executorRestarted: true, enrollmentRecovered: true, runtimeInstanceRecovered: true,
        priorSessionStaled: true, priorControllerCleared: true, activeOperationConservative: true,
        freshGenerationEstablished: true, duplicateEnrollmentObserved: false,
      },
    });
    expect(good.find((step) => step.id === 'restart.recovery')?.result).toBe('PASS');
    const bad = evaluateRuntimeProbe({
      restartRecovery: {
        attempted: true, executorRestarted: true, enrollmentRecovered: true, runtimeInstanceRecovered: true,
        priorSessionStaled: true, priorControllerCleared: false, activeOperationConservative: true,
        freshGenerationEstablished: true, duplicateEnrollmentObserved: false,
      },
    });
    expect(bad.find((step) => step.id === 'restart.recovery')?.result).toBe('FAIL');
  });

  it('builds evidence without executing live qualification', async () => {
    const manifest = await buildQualificationEvidence({
      fixtureSeed: SEED,
      runId: 'integration-no-live',
      environment: { env: {}, release: 'generic-linux' },
      runtimeProbe: null,
    });
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(manifest.environment).toMatchObject({ liveQualificationExecuted: false });
    const sourceStep = manifest.steps.find((step) => step.id === 'source.commit');
    expect(sourceStep?.detail).toMatchObject({ clean: expect.any(Boolean), statusEntryCount: expect.any(Number) });
    expect(sourceStep?.result).toBe(sourceStep?.detail.clean ? 'PASS' : 'FAIL');
    expect(manifest.steps.find((step) => step.id === 'environment.wsl')?.result).toBe('BLOCKED_ENVIRONMENT');
    expect(manifest.steps.find((step) => step.id === 'review.execution')?.result).toBe('NOT_RUN');
  });

  it('marks live qualification executed only when a live runtime probe is actually supplied', async () => {
    const manifest = await buildQualificationEvidence({
      fixtureSeed: SEED,
      runId: 'integration-live-probe',
      environment: { env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' }, release: 'linux' },
      runtimeProbe: { chatApi: { publicApiAvailable: false }, modelApi: { publicApiAvailable: false } },
    });
    expect(manifest.environment).toMatchObject({ liveQualificationExecuted: true });
    expect(manifest.steps.find((step) => step.id === 'cursor.chat_api')?.result).toBe('NOT_SUPPORTED');
    expect(manifest.steps.find((step) => step.id === 'cursor.model_api')?.result).toBe('NOT_SUPPORTED');
  });

  it('fails closed on malformed qualification status instead of coercing it', () => {
    expect(() => createQualificationStep({ id: 'bad.status', result: 'MAYBE' })).toThrow(/invalid qualification result/u);
    expect(evaluateRuntimeProbe({ modelApi: { publicApiAvailable: 'maybe' } })
      .find((step) => step.id === 'cursor.model_api')?.result).toBe('FAIL');
  });

  it('accepts only symbolic error classifications and rejects arbitrary raw error text', () => {
    expect(createQualificationStep({ id: 'error.safe', result: 'FAIL', error: 'MODEL_PROVIDER_ERROR' }).error)
      .toBe('MODEL_PROVIDER_ERROR');
    expect(() => createQualificationStep({ id: 'error.raw', result: 'FAIL', error: 'Bearer super-secret-value' }))
      .toThrow(/symbolic error code/u);
  });
});
