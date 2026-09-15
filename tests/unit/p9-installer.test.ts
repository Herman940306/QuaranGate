import { describe, expect, it } from 'vitest';
import {
  approveInstallPlan,
  buildInstallPlan,
  evaluateSystemReadiness,
  mapClientPermissions,
  profileDefaults,
  selectLocalAiProfile,
  type HostFacts,
  type InstallerAnswers,
} from '../../src/installer/productInstaller.js';

const gib = 1024 ** 3;
const digestA = 'a'.repeat(64);

function readyFacts(): HostFacts {
  return {
    platform: 'wsl',
    platformVersion: '2',
    wslDistribution: 'Ubuntu-24.04',
    wslVersion: 2,
    docker: { available: true, version: '29.7.2', daemonReachable: true },
    compose: { available: true, version: '5.5.0' },
    git: { available: true, version: '2.43.0' },
    node: { available: true, version: '24.20.0' },
    cpuCores: 8,
    memoryBytes: 32 * gib,
    storageBytesFree: 200 * gib,
    filesystem: {
      supportsAtomicRename: true,
      caseSensitive: true,
      installRootIsSymlink: false,
    },
    gpu: { present: true, name: 'Generic GPU', vramBytes: 12 * gib },
  };
}

function answers(overrides: Partial<InstallerAnswers> = {}): InstallerAnswers {
  return {
    schemaVersion: 1,
    host: readyFacts(),
    profile: 'RECOMMENDED',
    release: { state: 'RELEASE_GATE_PENDING' },
    installRoot: '/opt/quarangate',
    roots: {
      state: '/var/lib/quarangate',
      evidence: '/var/lib/quarangate/evidence',
      models: '/var/lib/quarangate/models',
      backups: '/var/lib/quarangate/backups',
      cache: '/var/cache/quarangate',
    },
    projects: [{
      id: 'sample-project',
      path: '/srv/projects/sample-project',
      access: 'READ_ONLY',
    }],
    providers: {
      kiro: { state: 'DEFERRED_ENTITLEMENT' },
      copilot: { state: 'DEFERRED_ENTITLEMENT' },
      ollama: { state: 'CONFIGURED' },
    },
    localAi: {
      profile: 'EFFICIENT',
      model: {
        id: 'qwen3.5:4b-q4_K_M',
        runtime: 'ollama',
        contextTokens: 32768,
      },
      limits: {
        cpuCores: 2,
        memoryBytes: 4 * gib,
        vramBytes: 4 * gib,
      },
    },
    ide: { state: 'UPSTREAM_P7_PENDING' },
    github: {
      enabled: true,
      account: 'Herman',
      repositories: ['QuaranGate'],
      permissions: ['metadata:read', 'contents:read'],
    },
    remote: { enabled: false },
    clientPermissions: ['READ_FILES', 'REVIEW_CHANGES', 'INSPECT_OPERATIONS'],
    startup: {
      enabled: true,
      mechanism: 'WINDOWS_TASK_SCHEDULER_WSL',
      runLevel: 'LIMITED',
    },
    backup: {
      profile: 'RECOMMENDED',
      location: '/var/lib/quarangate/backups',
      include: ['CONFIG', 'PROJECT_REFERENCES', 'DURABLE_STATE', 'EVIDENCE'],
      includeCredentials: false,
    },
    ...overrides,
  };
}

describe('P9 D1 system readiness', () => {
  it('classifies the supported WSL2/Docker toolchain as READY', () => {
    const result = evaluateSystemReadiness(readyFacts());
    expect(result.status).toBe('READY');
    expect(result.checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  it.each([
    ['missing Docker', { docker: { available: false } }, 'REMEDIATION_REQUIRED', 'DOCKER_MISSING'],
    ['unreachable daemon', { docker: { available: true, version: '29.7.2', daemonReachable: false } }, 'BLOCKED', 'DOCKER_DAEMON_UNREACHABLE'],
    ['incompatible Docker', { docker: { available: true, version: '23.0.0', daemonReachable: true } }, 'REMEDIATION_REQUIRED', 'DOCKER_VERSION_UNSUPPORTED'],
    ['missing Compose', { compose: { available: false } }, 'REMEDIATION_REQUIRED', 'COMPOSE_MISSING'],
    ['inadequate memory', { memoryBytes: 3 * gib }, 'BLOCKED', 'MEMORY_INADEQUATE'],
  ])('%s is classified truthfully', (_name, patch, status, code) => {
    const result = evaluateSystemReadiness({ ...readyFacts(), ...patch } as HostFacts);
    expect(result.status).toBe(status);
    expect(result.checks.some((check) => check.code === code && check.status !== 'PASS')).toBe(true);
  });

  it('refuses native Windows without WSL2 rather than fabricating support', () => {
    const facts = { ...readyFacts(), platform: 'windows' as const, wslVersion: undefined, wslDistribution: undefined };
    const result = evaluateSystemReadiness(facts);
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.checks.some((check) => check.code === 'WSL2_REQUIRED')).toBe(true);
  });
});

describe('P9 D1 guided owner choices', () => {
  it('provides all four profiles without granting hidden sensitive authority', () => {
    expect(Object.keys(profileDefaults()).sort()).toEqual(['ADVANCED_CUSTOM', 'DEVELOPER', 'QA_TESTING', 'RECOMMENDED']);
    for (const profile of Object.values(profileDefaults())) {
      expect(profile.remoteAccess).toBe(false);
      expect(profile.projectAccess).toBe('READ_ONLY');
      expect(profile.scopes).not.toContain('agents:apply');
      expect(profile.scopes).not.toContain('targets:control');
    }
  });

  it('maps human permissions onto the existing QuaranGate scopes', () => {
    expect(mapClientPermissions(['READ_FILES', 'RUN_TESTS', 'DISPATCH_AGENTS', 'APPLY_APPROVED_CHANGES'])).toEqual([
      'files:read',
      'terminal:exec',
      'agents:read',
      'agents:dispatch',
      'agents:apply',
    ]);
  });

  it('builds a deterministic, loopback-safe review plan with P7 pending', () => {
    const first = buildInstallPlan(answers());
    const second = buildInstallPlan(answers());

    expect(first.digest).toBe(second.digest);
    expect(first.readiness.status).toBe('READY');
    expect(first.review.remoteAccess).toBe('LOCAL_ONLY');
    expect(first.review.ideEnrollment).toBe('UPSTREAM_P7_PENDING');
    expect(first.review.controlCenterUrl).toBe('http://127.0.0.1:8787');
    expect(first.steps.at(-1)?.kind).toBe('OPEN_CONTROL_CENTER_AFTER_HEALTH');
    expect(first.steps.some((step) => step.kind === 'VERIFY_HEALTH')).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/mcpb_|token-value|plaintext-secret/u);
  });

  it('requires digest-bound owner consent before any mutation', () => {
    const plan = buildInstallPlan(answers());
    expect(() => approveInstallPlan(plan, {
      accepted: true,
      expectedPlanDigest: digestA,
      approvedSensitiveChoices: plan.requiredConsents,
    })).toThrow(/plan digest/u);

    expect(() => approveInstallPlan(plan, {
      accepted: false,
      expectedPlanDigest: plan.digest,
      approvedSensitiveChoices: [],
    })).toThrow(/owner consent/u);

    expect(approveInstallPlan(plan, {
      accepted: true,
      expectedPlanDigest: plan.digest,
      approvedSensitiveChoices: plan.requiredConsents,
    }).authorized).toBe(true);
  });

  it('keeps project write authority and powerful client scopes explicit', () => {
    const plan = buildInstallPlan(answers({
      projects: [{ id: 'write-project', path: '/srv/projects/write-project', access: 'READ_WRITE' }],
      clientPermissions: ['READ_FILES', 'APPLY_APPROVED_CHANGES', 'ADMINISTER_INFRASTRUCTURE'],
    }));
    expect(plan.requiredConsents).toContain('PROJECT_WRITE:write-project');
    expect(plan.requiredConsents).toContain('SCOPE:agents:apply');
    expect(plan.requiredConsents).toContain('SCOPE:targets:control');

    expect(() => approveInstallPlan(plan, {
      accepted: true,
      expectedPlanDigest: plan.digest,
      approvedSensitiveChoices: [],
    })).toThrow(/missing explicit consent/u);
  });

  it('rejects broad home/root enrollment and preserves guarded paths', () => {
    expect(() => buildInstallPlan(answers({
      projects: [{ id: 'too-broad', path: '/home/herman', access: 'READ_ONLY' }],
    }))).toThrow(/broad home/u);

    const plan = buildInstallPlan(answers());
    expect(plan.projects[0]?.guards).toEqual(expect.arrayContaining(['.git', '.env', 'secrets', 'credentials']));
  });

  it('refuses raw provider secrets and handles unavailable entitlements', () => {
    const pending = buildInstallPlan(answers());
    expect(pending.review.providers).toMatchObject({
      kiro: 'DEFERRED_ENTITLEMENT',
      copilot: 'DEFERRED_ENTITLEMENT',
      ollama: 'CONFIGURED',
    });

    const unsafe = answers({
      providers: {
        kiro: { state: 'CONFIGURED', credential: { storage: 'ENVIRONMENT', reference: 'KIRO_TOKEN', secret: 'token-value' } } as never,
        copilot: { state: 'DEFERRED_ENTITLEMENT' },
        ollama: { state: 'CONFIGURED' },
      },
    });
    expect(() => buildInstallPlan(unsafe)).toThrow(/credential fields/u);
  });

  it('binds IDE support only to an accepted, hashed upstream contract', () => {
    expect(() => buildInstallPlan(answers({
      ide: { state: 'READY', contract: { version: 1, digest: 'bad', adapterIds: ['vscode'] } },
    }))).toThrow(/IDE contract digest/u);

    const plan = buildInstallPlan(answers({
      ide: { state: 'READY', contract: { version: 1, digest: digestA, adapterIds: ['vscode'] } },
    }));
    expect(plan.review.ideEnrollment).toBe('READY:vscode');
  });

  it('requires selected repositories and refuses wildcard GitHub authority', () => {
    expect(() => buildInstallPlan(answers({
      github: {
        enabled: true,
        account: 'Herman',
        repositories: ['*'],
        permissions: ['metadata:read'],
      },
    }))).toThrow(/selected repositories/u);
  });

  it('makes remote access opt-in, reviewable, and reversible', () => {
    const plan = buildInstallPlan(answers({
      remote: {
        enabled: true,
        mechanism: 'TAILSCALE_PRIVATE',
        reversible: true,
        publicExposure: false,
      },
    }));
    expect(plan.requiredConsents).toContain('REMOTE_ACCESS:TAILSCALE_PRIVATE');
    expect(plan.review.remoteAccess).toBe('TAILSCALE_PRIVATE');
    expect(plan.steps.some((step) => step.kind === 'OPEN_PUBLIC_PORT')).toBe(false);
  });

  it('selects local-AI profiles from detected resources and validates custom limits', () => {
    expect(selectLocalAiProfile(readyFacts(), 'BALANCED').profile).toBe('BALANCED');
    const constrained = { ...readyFacts(), memoryBytes: 8 * gib, gpu: { present: false } };
    expect(selectLocalAiProfile(constrained, 'BALANCED').profile).toBe('EFFICIENT');
    expect(() => buildInstallPlan(answers({
      localAi: {
        profile: 'CUSTOM',
        model: { id: 'model:v1', runtime: 'ollama', contextTokens: 0 },
        limits: { cpuCores: 99, memoryBytes: 100 * gib, vramBytes: 0 },
      },
    }))).toThrow(/local AI/u);
  });
});
