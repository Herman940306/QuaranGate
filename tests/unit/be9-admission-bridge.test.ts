import { describe, expect, it } from 'vitest';
import type { Principal } from '../../src/gateway/config.js';
import { SecurityAssessmentAdmissionService } from '../../src/gateway/securityAssessmentAdmission.js';
import type {
  ProductAssessmentAdmissionRequest,
  SecurityAssessmentOperationalPreflight,
} from '../../src/shared/securityAssessment.js';

const NOW = new Date('2026-09-27T19:00:00.000Z');

function principal(patch: Partial<Principal> = {}): Principal {
  return {
    id: 'principal-a',
    name: 'Principal A',
    keyHash: 'a'.repeat(64),
    scopes: ['security:assessment:read', 'security:assessment:write'],
    targets: ['target-a'],
    enabled: true,
    projects: ['project-a'],
    agentBackends: [],
    agentProfiles: [],
    githubAccounts: [],
    githubProjects: [],
    ...patch,
  };
}

function request(patch: Partial<ProductAssessmentAdmissionRequest> = {}): ProductAssessmentAdmissionRequest {
  return {
    schemaVersion: 'BE9_ADMISSION_V1',
    bridgeRequestId: `bar_${'1'.repeat(24)}`,
    productActorRef: 'product-service-a',
    productUserId: 'user-a',
    organizationId: 'org-a',
    workspaceId: 'workspace-a',
    assessmentId: `assessment_${'2'.repeat(24)}`,
    assessmentVersion: 0,
    correlationId: 'corr-a',
    principalRef: 'principal-a',
    principalMappingVersion: 7,
    discoveryId: `disc_${'3'.repeat(24)}`,
    discoveryDigest: '4'.repeat(64),
    planId: `plan_${'5'.repeat(24)}`,
    planDigest: '6'.repeat(64),
    projectId: 'project-a',
    targetId: 'target-a',
    expectedSourceRevision: '7'.repeat(40),
    assessmentIntent: 'source',
    requestedCapabilityClasses: ['SAST'],
    networkClass: 'NONE',
    credentialClass: 'NONE',
    requestedAt: '2026-09-27T18:59:50.000Z',
    expiresAt: '2026-09-27T19:00:40.000Z',
    nonce: '8'.repeat(32),
    ...patch,
  };
}

function preflight(patch: Partial<SecurityAssessmentOperationalPreflight> = {}): SecurityAssessmentOperationalPreflight {
  return {
    projectId: 'project-a',
    targetId: 'target-a',
    sourceRevision: '7'.repeat(40),
    sourceTree: '9'.repeat(40),
    clean: true,
    gitRequired: true,
    resourceAvailable: true,
    capabilityStatus: 'AVAILABLE',
    capabilityCode: 'CAPABILITY_AVAILABLE',
    ...patch,
  };
}

function admissionService(
  deps: Omit<ConstructorParameters<typeof SecurityAssessmentAdmissionService>[0], 'claimReplay'>,
): SecurityAssessmentAdmissionService {
  const seen = new Set<string>();
  return new SecurityAssessmentAdmissionService({
    ...deps,
    claimReplay: async ({ bridgeRequestId, nonce }) => {
      const key = `${bridgeRequestId}:${nonce}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  });
}

describe('BE9.2 product operational admission bridge', () => {
  it('fails closed when durable replay protection is unavailable', async () => {
    const service = new SecurityAssessmentAdmissionService({
      principalById: () => principal(),
      preflight: async () => preflight(),
      now: () => NOW,
    });
    await expect(service.admitProduct(request())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('durable assessment replay protection is unavailable'),
    });
  });

  it('resolves current Principal only from the server-bound principalRef, never workspace', async () => {
    const lookups: string[] = [];
    const service = admissionService({
      principalById: (id) => {
        lookups.push(id);
        return principal();
      },
      preflight: async () => preflight(),
      now: () => NOW,
    });

    const receipt = await service.admitProduct(request({
      organizationId: 'org-another-audit-context',
      workspaceId: 'workspace-another-audit-context',
    }));

    expect(lookups).toEqual(['principal-a']);
    expect(receipt.decision).toBe('ADMITTED');
    expect(receipt.resolvedPrincipalId).toBe('principal-a');
    expect(receipt.resolvedProjectId).toBe('project-a');
    expect(receipt.resolvedTargetId).toBe('target-a');
    expect(receipt.resolvedSourceRevision).toBe('7'.repeat(40));
    expect(receipt.admissionReceiptDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('denies current Principal revocation without calling preflight', async () => {
    let preflightCalls = 0;
    const service = admissionService({
      principalById: () => principal({ enabled: false }),
      preflight: async () => {
        preflightCalls++;
        return preflight();
      },
      now: () => NOW,
    });

    const receipt = await service.admitProduct(request());
    expect(receipt.decision).toBe('DENIED_POLICY');
    expect(receipt.decisionCode).toBe('CLIENT_DISABLED');
    expect(preflightCalls).toBe(0);
  });

  it('denies revoked project/target/scope grants before operational source inspection', async () => {
    for (const current of [
      principal({ projects: [] }),
      principal({ targets: [] }),
      principal({ scopes: [] }),
    ]) {
      let preflightCalls = 0;
      const service = admissionService({
        principalById: () => current,
        preflight: async () => {
          preflightCalls++;
          return preflight();
        },
        now: () => NOW,
      });
      const receipt = await service.admitProduct(request({
        bridgeRequestId: `bar_${String(preflightCalls + 3).repeat(24).slice(0, 24)}`,
        nonce: String(preflightCalls + 9).repeat(32).slice(0, 32),
      }));
      expect(receipt.decision).toBe('DENIED_POLICY');
      expect(preflightCalls).toBe(0);
    }
  });

  it('keeps resource and scanner unavailability nonterminal and truthful', async () => {
    const resourceBusy = admissionService({
      principalById: () => principal(),
      preflight: async () => preflight({ resourceAvailable: false }),
      now: () => NOW,
    });
    await expect(resourceBusy.admitProduct(request()))
      .resolves.toMatchObject({
        decision: 'TEMPORARILY_UNAVAILABLE',
        decisionCode: 'EXECUTION_RESOURCE_BUSY',
      });

    const scannerMissing = admissionService({
      principalById: () => principal(),
      preflight: async () => preflight({
        capabilityStatus: 'UNAVAILABLE',
        capabilityCode: 'BE10_SCANNER_PLUGIN_UNAVAILABLE',
      }),
      now: () => NOW,
    });
    await expect(scannerMissing.admitProduct(request({
      bridgeRequestId: `bar_${'a'.repeat(24)}`,
      nonce: 'b'.repeat(32),
    }))).resolves.toMatchObject({
      decision: 'TEMPORARILY_UNAVAILABLE',
      decisionCode: 'BE10_SCANNER_PLUGIN_UNAVAILABLE',
    });
  });

  it('fails closed when operational project/target/source binding disagrees with product binding', async () => {
    for (const mismatch of [
      preflight({ projectId: 'project-b' }),
      preflight({ targetId: 'target-b' }),
      preflight({ sourceRevision: '0'.repeat(40) }),
    ]) {
      const service = admissionService({
        principalById: () => principal(),
        preflight: async () => mismatch,
        now: () => NOW,
      });
      const receipt = await service.admitProduct(request({
        bridgeRequestId: `bar_${mismatch.projectId.endsWith('b') ? 'c'.repeat(24) : mismatch.targetId?.endsWith('b') ? 'd'.repeat(24) : 'e'.repeat(24)}`,
        nonce: mismatch.projectId.endsWith('b') ? 'c'.repeat(32) : mismatch.targetId?.endsWith('b') ? 'd'.repeat(32) : 'e'.repeat(32),
      }));
      expect(receipt.decision).toBe('FAILED_PRECONDITION');
      expect(receipt.decisionCode).toBe('OPERATIONAL_BINDING_MISMATCH');
    }
  });

  it('rejects expired requests and detects exact bridge request replay', async () => {
    const service = admissionService({
      principalById: () => principal(),
      preflight: async () => preflight(),
      now: () => NOW,
    });
    await expect(service.admitProduct(request({
      requestedAt: '2026-09-27T18:58:00.000Z',
      expiresAt: '2026-09-27T18:58:30.000Z',
    }))).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });

    const accepted = await service.admitProduct(request());
    expect(accepted.decision).toBe('ADMITTED');
    const replayed = await service.admitProduct(request());
    expect(replayed.decision).toBe('REPLAY_REJECTED');
    expect(replayed.decisionCode).toBe('BRIDGE_REQUEST_REPLAY');
  });

  it('rejects caller-shaped authority fields that are not in the closed bridge schema', async () => {
    const service = admissionService({
      principalById: () => principal(),
      preflight: async () => preflight(),
      now: () => NOW,
    });
    await expect(service.admitProduct({
      ...request(),
      hostPath: '/attacker',
      scannerImage: 'attacker:latest',
      argv: ['sh', '-c', 'id'],
    } as never)).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });
});
