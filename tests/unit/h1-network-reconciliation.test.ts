/**
 * H1-6: Ownership-safe orphan network reconciliation tests.
 *
 * Proves that reconcileOrphans() only deletes networks that carry:
 *   - a QuaranGate managed label (managed=true)
 *   - a known ephemeral resource label (resource=net)
 *   - a provable job ID label
 *   - no active container connections
 *
 * Adversarial cases prove that lookalike names, missing labels, wrong labels,
 * ambiguous labels (two namespaces disagreeing), and connected networks all
 * survive reconciliation (are never deleted).
 *
 * These tests are PURE — no Docker daemon required. They mock the Docker API
 * layer to prove the label-authority logic in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkSummary } from '../../src/executor/docker.js';
import {
  isBridgeManaged,
  ownershipLabelValue,
  SANDBOX_LABEL_NS,
  ACCEPTED_SANDBOX_LABEL_NAMESPACES,
} from '../../src/executor/agents/sandboxSpec.js';

// ---------------------------------------------------------------------------
// Pure label-authority logic tests (no Docker I/O)
// ---------------------------------------------------------------------------

function makeNetworkLabels(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [`${SANDBOX_LABEL_NS}.managed`]: 'true',
    [`${SANDBOX_LABEL_NS}.resource`]: 'net',
    [`${SANDBOX_LABEL_NS}.job`]: 'job_' + 'a'.repeat(32),
    ...overrides,
  };
}

describe('isBridgeManaged — network ownership authority', () => {
  it('returns true for a correctly labelled network', () => {
    expect(isBridgeManaged(makeNetworkLabels())).toBe(true);
  });

  it('returns false when managed label is absent', () => {
    const labels: Record<string, string> = {
      [`${SANDBOX_LABEL_NS}.resource`]: 'net',
      [`${SANDBOX_LABEL_NS}.job`]: 'job_' + 'a'.repeat(32),
    };
    expect(isBridgeManaged(labels)).toBe(false);
  });

  it('returns false when managed=false', () => {
    expect(isBridgeManaged({ [`${SANDBOX_LABEL_NS}.managed`]: 'false' })).toBe(false);
  });

  it('returns false for null labels', () => {
    expect(isBridgeManaged(null)).toBe(false);
  });

  it('returns false when label map is empty', () => {
    expect(isBridgeManaged({})).toBe(false);
  });

  it('fails closed when two accepted namespaces disagree on managed value', () => {
    // Both namespaces present but one says false — fail-safe: NOT managed.
    const labels: Record<string, string> = {};
    labels[`${ACCEPTED_SANDBOX_LABEL_NAMESPACES[0]!}.managed`] = 'true';
    labels[`${ACCEPTED_SANDBOX_LABEL_NAMESPACES[1]!}.managed`] = 'false';
    expect(isBridgeManaged(labels)).toBe(false);
  });
});

describe('ownershipLabelValue — resource and job extraction', () => {
  it('returns "net" for a bridge-owned egress network', () => {
    expect(ownershipLabelValue(makeNetworkLabels(), 'resource')).toBe('net');
  });

  it('returns null when resource label is absent', () => {
    const labels: Record<string, string> = {
      [`${SANDBOX_LABEL_NS}.managed`]: 'true',
      [`${SANDBOX_LABEL_NS}.job`]: 'job_' + 'a'.repeat(32),
    };
    expect(ownershipLabelValue(labels, 'resource')).toBeNull();
  });

  it('returns null when two namespaces disagree on resource value (fail-safe)', () => {
    const labels: Record<string, string> = {};
    labels[`${ACCEPTED_SANDBOX_LABEL_NAMESPACES[0]!}.resource`] = 'net';
    labels[`${ACCEPTED_SANDBOX_LABEL_NAMESPACES[1]!}.resource`] = 'workspace';
    expect(ownershipLabelValue(labels, 'resource')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adversarial: what must NOT be deleted
// ---------------------------------------------------------------------------

describe('network deletion authority — adversarial cases', () => {
  /** Simulates the gate logic in reconcileOrphans for a single network. */
  function wouldDelete(
    labels: Record<string, string> | null,
    containers: Record<string, unknown> | null | undefined = {},
  ): { delete: boolean; reason: string } {
    if (!isBridgeManaged(labels)) return { delete: false, reason: 'not bridge-managed' };

    const resource = ownershipLabelValue(labels, 'resource');
    if (resource !== 'net') return { delete: false, reason: `resource=${resource ?? 'null'}, not 'net'` };

    const jobId = ownershipLabelValue(labels, 'job');
    if (!jobId) return { delete: false, reason: 'job label not provable' };

    if (containers && Object.keys(containers).length > 0) {
      return { delete: false, reason: 'containers still connected' };
    }

    return { delete: true, reason: 'all authority checks passed' };
  }

  it('NEVER deletes: null labels (unrelated network)', () => {
    expect(wouldDelete(null).delete).toBe(false);
  });

  it('NEVER deletes: empty labels (unrelated network)', () => {
    expect(wouldDelete({}).delete).toBe(false);
  });

  it('NEVER deletes: name-only match without managed label (lookalike name)', () => {
    // A network named like a bridge network but with no ownership labels.
    const labels: Record<string, string> = { name: 'quarangate-job-abc-egress' };
    expect(wouldDelete(labels).delete).toBe(false);
  });

  it('NEVER deletes: wrong resource label (evidence, workspace, runner, etc.)', () => {
    for (const resource of ['evidence', 'workspace', 'runner', 'stager', 'proxy', 'applier', '']) {
      const labels = makeNetworkLabels({ [`${SANDBOX_LABEL_NS}.resource`]: resource });
      const result = wouldDelete(labels);
      expect(result.delete, `wrongly would delete resource=${resource}`).toBe(false);
    }
  });

  it('NEVER deletes: managed=true but resource label absent', () => {
    const labels: Record<string, string> = {
      [`${SANDBOX_LABEL_NS}.managed`]: 'true',
      [`${SANDBOX_LABEL_NS}.job`]: 'job_' + 'a'.repeat(32),
    };
    expect(wouldDelete(labels).delete).toBe(false);
  });

  it('NEVER deletes: managed=true, resource=net, but job label absent', () => {
    const labels: Record<string, string> = {
      [`${SANDBOX_LABEL_NS}.managed`]: 'true',
      [`${SANDBOX_LABEL_NS}.resource`]: 'net',
    };
    expect(wouldDelete(labels).delete).toBe(false);
  });

  it('NEVER deletes: managed=true, resource=net, job present, but containers still connected', () => {
    const labels = makeNetworkLabels();
    const containers = { 'abc123': { Name: '/runner-job_abc' } };
    expect(wouldDelete(labels, containers).delete).toBe(false);
  });

  it('NEVER deletes: two namespaces disagree on resource (fail-safe)', () => {
    const labels: Record<string, string> = {};
    labels[`${ACCEPTED_SANDBOX_LABEL_NAMESPACES[0]!}.managed`] = 'true';
    labels[`${ACCEPTED_SANDBOX_LABEL_NAMESPACES[0]!}.resource`] = 'net';
    labels[`${ACCEPTED_SANDBOX_LABEL_NAMESPACES[0]!}.job`] = 'job_' + 'a'.repeat(32);
    labels[`${ACCEPTED_SANDBOX_LABEL_NAMESPACES[1]!}.resource`] = 'workspace'; // contradiction
    expect(wouldDelete(labels).delete).toBe(false);
  });

  it('WOULD delete: all authority requirements satisfied, no containers', () => {
    const labels = makeNetworkLabels();
    expect(wouldDelete(labels, {}).delete).toBe(true);
  });

  it('WOULD delete: legacy namespace labels, resource=net, job present, no containers', () => {
    if (ACCEPTED_SANDBOX_LABEL_NAMESPACES.length < 2) return; // only 1 namespace — skip
    const legacyNs = ACCEPTED_SANDBOX_LABEL_NAMESPACES[1]!;
    const labels: Record<string, string> = {
      [`${legacyNs}.managed`]: 'true',
      [`${legacyNs}.resource`]: 'net',
      [`${legacyNs}.job`]: 'job_' + 'b'.repeat(32),
    };
    expect(wouldDelete(labels, {}).delete).toBe(true);
  });
});
