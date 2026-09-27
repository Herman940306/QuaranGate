import { describe, expect, it } from 'vitest';
import type { Principal } from '../../src/gateway/config.js';
import { authorizeSecurityAssessmentBinding } from '../../src/gateway/securityAssessmentAuthz.js';
import type { SecurityAssessmentOperationalBinding } from '../../src/shared/securityAssessment.js';
import { BridgeError } from '../../src/shared/errors.js';

const binding: SecurityAssessmentOperationalBinding = {
  assessmentId: 'assessment_0123456789abcdef01234567',
  assessmentVersion: 0,
  correlationId: 'corr-a',
  principalRef: 'principal-a',
  principalMappingVersion: 4,
  discoveryId: 'disc_0123456789abcdef01234567',
  discoveryDigest: 'a'.repeat(64),
  planId: 'plan_0123456789abcdef01234567',
  planDigest: 'b'.repeat(64),
  projectId: 'project-a',
  targetId: 'target-a',
  expectedSourceRevision: 'c'.repeat(40),
  assessmentIntent: 'source',
  requestedCapabilityClasses: ['SAST'],
  networkClass: 'NONE',
  credentialClass: 'NONE',
};

function principal(patch: Partial<Principal> = {}): Principal {
  return {
    id: 'principal-a',
    name: 'Principal A',
    keyHash: 'd'.repeat(64),
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

describe('BE9.2 operational Principal authorization', () => {
  it('authorizes exact current Principal/project/target binding', () => {
    expect(() => authorizeSecurityAssessmentBinding(principal(), binding, 'write')).not.toThrow();
    expect(() => authorizeSecurityAssessmentBinding(principal(), binding, 'read')).not.toThrow();
  });

  it('rejects a different current Principal even if it has the same project and target grants', () => {
    expect(() => authorizeSecurityAssessmentBinding(
      principal({ id: 'principal-b' }),
      binding,
      'write',
    )).toThrowError(expect.objectContaining({ code: 'FORBIDDEN_PROJECT' }));
  });

  it('rejects a revoked/disabled Principal', () => {
    expect(() => authorizeSecurityAssessmentBinding(
      principal({ enabled: false }),
      binding,
      'write',
    )).toThrowError(expect.objectContaining({ code: 'CLIENT_DISABLED' }));
  });

  it('rejects revoked project grant', () => {
    expect(() => authorizeSecurityAssessmentBinding(
      principal({ projects: [] }),
      binding,
      'write',
    )).toThrowError(expect.objectContaining({ code: 'FORBIDDEN_PROJECT' }));
  });

  it('rejects revoked target grant', () => {
    expect(() => authorizeSecurityAssessmentBinding(
      principal({ targets: [] }),
      binding,
      'write',
    )).toThrowError(expect.objectContaining({ code: 'FORBIDDEN_TARGET' }));
  });

  it('requires assessment-specific scopes instead of reusing agent or target authority', () => {
    expect(() => authorizeSecurityAssessmentBinding(
      principal({ scopes: ['agents:dispatch', 'targets:control'] }),
      binding,
      'write',
    )).toThrowError(expect.objectContaining({ code: 'FORBIDDEN_SCOPE' }));
  });

  it('fails closed on network or credential widening', () => {
    expect(() => authorizeSecurityAssessmentBinding(
      principal(),
      { ...binding, networkClass: 'INTERNET' as never },
      'write',
    )).toThrowError(BridgeError);
    expect(() => authorizeSecurityAssessmentBinding(
      principal(),
      { ...binding, credentialClass: 'PROVIDER' as never },
      'write',
    )).toThrowError(BridgeError);
  });
});
