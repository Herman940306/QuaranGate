/**
 * N1D identity-migration compatibility (MCP_IDE_BRIDGE_MASTER_PRD.md §47.4/§47.5).
 *
 * Proves the dual-read / new-write contract for the ownership label namespace
 * and the evidence volume prefix:
 *
 *   WRITE: io.quarangate.*        / io-quarangate-evidence-*   (only)
 *   READ:  io.quarangate.*  UNION io.mcp-ide-bridge.*  UNION io.mcp-bridge.*
 *          io-quarangate-evidence-*  UNION  io-mcp-ide-bridge-evidence-*
 *
 * The Docker-filter shape is load-bearing and is asserted directly: Docker ANDs
 * the entries of a `label` filter array, so a single filter listing several
 * namespaces would match only resources carrying ALL of them — i.e. nothing.
 * Dual-read must therefore be N separate queries unioned by the caller.
 */
import { describe, it, expect } from 'vitest';
import {
  SANDBOX_LABEL_NS,
  LEGACY_SANDBOX_LABEL_NAMESPACES,
  ACCEPTED_SANDBOX_LABEL_NAMESPACES,
  LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB, LABEL_ATTEMPT,
  MANAGED_FILTER, managedLabelFilters,
  isBridgeManaged, ownershipLabelValue, ownershipLabels, applierOwnershipLabels,
  workspaceVolumeName, runnerContainerName, stagerContainerName, applierContainerName,
  EVIDENCE_VOLUME_PREFIX, LEGACY_EVIDENCE_VOLUME_PREFIXES,
  ACCEPTED_EVIDENCE_VOLUME_PREFIXES,
  evidenceVolumeName, acceptedEvidenceVolumeNames,
  isAcceptedEvidenceVolumeName, hasAcceptedEvidenceVolumePrefix,
} from '../../src/executor/agents/sandboxSpec.js';

const JOB = 'job_' + 'a'.repeat(32);
const OTHER_JOB = 'job_' + 'b'.repeat(32);
const ATTEMPT = 'att_' + 'c'.repeat(32);

const NEW_NS = 'io.quarangate';
const LEGACY_SANDBOX_NS = 'io.mcp-ide-bridge';
const LEGACY_CONTROL_NS = 'io.mcp-bridge';

// ---------------------------------------------------------------------------
// Frozen namespace contract
// ---------------------------------------------------------------------------

describe('N1D ownership namespace contract', () => {
  it('writes the QuaranGate namespace only', () => {
    expect(SANDBOX_LABEL_NS).toBe(NEW_NS);
    expect(LABEL_MANAGED).toBe(`${NEW_NS}.managed`);
    expect(LABEL_RESOURCE).toBe(`${NEW_NS}.resource`);
    expect(LABEL_JOB).toBe(`${NEW_NS}.job`);
    expect(LABEL_ATTEMPT).toBe(`${NEW_NS}.attempt`);
  });

  it('accepts exactly the two frozen legacy namespaces on read', () => {
    expect([...LEGACY_SANDBOX_LABEL_NAMESPACES].sort())
      .toEqual([LEGACY_CONTROL_NS, LEGACY_SANDBOX_NS].sort());
    expect(ACCEPTED_SANDBOX_LABEL_NAMESPACES[0]).toBe(NEW_NS);
    expect(ACCEPTED_SANDBOX_LABEL_NAMESPACES).toHaveLength(3);
  });

  it('emits no legacy-namespace key from any writer helper', () => {
    const written = [
      ...Object.keys(ownershipLabels('runner', JOB)),
      ...Object.keys(applierOwnershipLabels(JOB, ATTEMPT)),
    ];
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(key.startsWith(`${NEW_NS}.`)).toBe(true);
      for (const legacy of LEGACY_SANDBOX_LABEL_NAMESPACES) {
        expect(key.startsWith(`${legacy}.`)).toBe(false);
      }
    }
  });

  it('derives resource names from the QuaranGate namespace', () => {
    expect(workspaceVolumeName(JOB)).toBe(`io-quarangate-ws-${JOB}`);
    expect(runnerContainerName(JOB)).toBe(`io-quarangate-runner-${JOB}`);
    expect(stagerContainerName(JOB)).toBe(`io-quarangate-stager-${JOB}`);
    expect(applierContainerName(ATTEMPT)).toBe(`io-quarangate-applier-${ATTEMPT}`);
  });
});

// ---------------------------------------------------------------------------
// Docker filter shape — the AND-semantics trap
// ---------------------------------------------------------------------------

describe('managedLabelFilters (Docker AND-semantics safety)', () => {
  it('returns one INDEPENDENT filter per accepted namespace', () => {
    const filters = managedLabelFilters();
    expect(filters).toHaveLength(ACCEPTED_SANDBOX_LABEL_NAMESPACES.length);
    expect(filters).toEqual([
      { label: [`${NEW_NS}.managed=true`] },
      { label: [`${LEGACY_SANDBOX_NS}.managed=true`] },
      { label: [`${LEGACY_CONTROL_NS}.managed=true`] },
    ]);
  });

  it('never puts two namespaces in one filter array (would AND to nothing)', () => {
    for (const filter of managedLabelFilters([['resource', 'evidence']])) {
      const namespaces = new Set(
        filter.label.map((entry) => entry.slice(0, entry.lastIndexOf('.'))),
      );
      expect(namespaces.size).toBe(1);
    }
  });

  it('expresses extra constraints in the SAME namespace as the managed label', () => {
    expect(managedLabelFilters([['resource', 'evidence']])).toEqual([
      { label: [`${NEW_NS}.managed=true`, `${NEW_NS}.resource=evidence`] },
      { label: [`${LEGACY_SANDBOX_NS}.managed=true`, `${LEGACY_SANDBOX_NS}.resource=evidence`] },
      { label: [`${LEGACY_CONTROL_NS}.managed=true`, `${LEGACY_CONTROL_NS}.resource=evidence`] },
    ]);
  });

  it('keeps the single-namespace MANAGED_FILTER scoped to the new namespace', () => {
    // Retained for callers that intentionally want only current-namespace
    // resources. It must never silently claim to cover legacy ones.
    expect(MANAGED_FILTER).toEqual({ label: [`${NEW_NS}.managed=true`] });
  });
});

// ---------------------------------------------------------------------------
// Union / dedupe semantics against a simulated Docker daemon
// ---------------------------------------------------------------------------

interface FakeVolume { Name: string; Labels: Record<string, string> | null }

/** Docker's real filter semantics: every entry in `label` must match (AND). */
function fakeListVolumesByFilter(all: FakeVolume[], filter: Record<string, string[]>): FakeVolume[] {
  const required = filter.label ?? [];
  return all.filter((v) => required.every((entry) => {
    const eq = entry.indexOf('=');
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    return (v.Labels ?? {})[key] === value;
  }));
}

function unionAcrossNamespaces(all: FakeVolume[]): FakeVolume[] {
  const byName = new Map<string, FakeVolume>();
  for (const filter of managedLabelFilters()) {
    for (const v of fakeListVolumesByFilter(all, filter)) {
      if (!byName.has(v.Name)) byName.set(v.Name, v);
    }
  }
  return [...byName.values()];
}

describe('dual-read discovery union', () => {
  const legacyOnly: FakeVolume = {
    Name: 'legacy-only',
    Labels: { [`${LEGACY_SANDBOX_NS}.managed`]: 'true', [`${LEGACY_SANDBOX_NS}.resource`]: 'workspace', [`${LEGACY_SANDBOX_NS}.job`]: JOB },
  };
  const controlLegacyOnly: FakeVolume = {
    Name: 'legacy-control-only',
    Labels: { [`${LEGACY_CONTROL_NS}.managed`]: 'true', [`${LEGACY_CONTROL_NS}.resource`]: 'control', [`${LEGACY_CONTROL_NS}.job`]: JOB },
  };
  const newOnly: FakeVolume = {
    Name: 'quarangate-only',
    Labels: { [`${NEW_NS}.managed`]: 'true', [`${NEW_NS}.resource`]: 'workspace', [`${NEW_NS}.job`]: JOB },
  };
  const bothNamespaces: FakeVolume = {
    Name: 'both-namespaces',
    Labels: {
      [`${NEW_NS}.managed`]: 'true', [`${NEW_NS}.resource`]: 'workspace', [`${NEW_NS}.job`]: JOB,
      [`${LEGACY_SANDBOX_NS}.managed`]: 'true', [`${LEGACY_SANDBOX_NS}.resource`]: 'workspace', [`${LEGACY_SANDBOX_NS}.job`]: JOB,
    },
  };
  const unmanaged: FakeVolume = { Name: 'someone-elses-volume', Labels: { 'com.example.managed': 'true' } };
  const unlabelled: FakeVolume = { Name: 'no-labels', Labels: null };

  const all = [legacyOnly, controlLegacyOnly, newOnly, bothNamespaces, unmanaged, unlabelled];

  it('finds a legacy-only object', () => {
    expect(unionAcrossNamespaces(all).map((v) => v.Name)).toContain('legacy-only');
  });

  it('finds a legacy control-namespace object', () => {
    expect(unionAcrossNamespaces(all).map((v) => v.Name)).toContain('legacy-control-only');
  });

  it('finds a QuaranGate-only object', () => {
    expect(unionAcrossNamespaces(all).map((v) => v.Name)).toContain('quarangate-only');
  });

  it('returns an object carrying BOTH namespaces exactly once', () => {
    const names = unionAcrossNamespaces(all).map((v) => v.Name);
    expect(names.filter((n) => n === 'both-namespaces')).toHaveLength(1);
  });

  it('excludes unmanaged and unlabelled objects', () => {
    const names = unionAcrossNamespaces(all).map((v) => v.Name);
    expect(names).not.toContain('someone-elses-volume');
    expect(names).not.toContain('no-labels');
  });

  it('proves a single combined filter would find NOTHING (the trap being avoided)', () => {
    const combined = {
      label: [`${NEW_NS}.managed=true`, `${LEGACY_SANDBOX_NS}.managed=true`, `${LEGACY_CONTROL_NS}.managed=true`],
    };
    // Only a resource carrying all three namespaces at once could match — none
    // exists in practice, which is exactly why dual-read must be N queries.
    expect(fakeListVolumesByFilter(all, combined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ownership reads — fail-safe on ambiguity
// ---------------------------------------------------------------------------

describe('isBridgeManaged / ownershipLabelValue', () => {
  it('recognises the managed label in every accepted namespace', () => {
    for (const ns of ACCEPTED_SANDBOX_LABEL_NAMESPACES) {
      expect(isBridgeManaged({ [`${ns}.managed`]: 'true' })).toBe(true);
    }
  });

  it('rejects absent, false, and non-bridge labels', () => {
    expect(isBridgeManaged(null)).toBe(false);
    expect(isBridgeManaged(undefined)).toBe(false);
    expect(isBridgeManaged({})).toBe(false);
    expect(isBridgeManaged({ [`${NEW_NS}.managed`]: 'false' })).toBe(false);
    expect(isBridgeManaged({ 'com.example.managed': 'true' })).toBe(false);
  });

  it('is FAIL-SAFE when namespaces contradict each other on managed', () => {
    expect(isBridgeManaged({
      [`${NEW_NS}.managed`]: 'true',
      [`${LEGACY_SANDBOX_NS}.managed`]: 'false',
    })).toBe(false);
  });

  it('reads a consistent value shared across namespaces', () => {
    const labels = { [`${NEW_NS}.job`]: JOB, [`${LEGACY_SANDBOX_NS}.job`]: JOB };
    expect(ownershipLabelValue(labels, 'job')).toBe(JOB);
  });

  it('returns null (not a guess) when namespaces disagree on job identity', () => {
    const labels = { [`${NEW_NS}.job`]: JOB, [`${LEGACY_SANDBOX_NS}.job`]: OTHER_JOB };
    expect(ownershipLabelValue(labels, 'job')).toBeNull();
  });

  it('returns null when the label is absent entirely', () => {
    expect(ownershipLabelValue({}, 'resource')).toBeNull();
    expect(ownershipLabelValue(null, 'resource')).toBeNull();
  });

  it('reads a legacy resource label — the guard protecting retained evidence', () => {
    // sandboxRunner.reconcileOrphans skips resource==='evidence'. Reading only
    // the new namespace would see undefined here and DELETE retained
    // pre-cutover evidence.
    const legacyEvidence = {
      [`${LEGACY_SANDBOX_NS}.managed`]: 'true',
      [`${LEGACY_SANDBOX_NS}.resource`]: 'evidence',
      [`${LEGACY_SANDBOX_NS}.job`]: JOB,
    };
    expect(isBridgeManaged(legacyEvidence)).toBe(true);
    expect(ownershipLabelValue(legacyEvidence, 'resource')).toBe('evidence');
  });
});

// ---------------------------------------------------------------------------
// Evidence prefix compatibility (§47.5)
// ---------------------------------------------------------------------------

describe('N1D evidence volume prefix contract', () => {
  it('writes the QuaranGate prefix only', () => {
    expect(EVIDENCE_VOLUME_PREFIX).toBe('io-quarangate-evidence-');
    expect(evidenceVolumeName(JOB)).toBe(`io-quarangate-evidence-${JOB}`);
  });

  it('accepts exactly the frozen legacy prefix on read', () => {
    expect(LEGACY_EVIDENCE_VOLUME_PREFIXES).toEqual(['io-mcp-ide-bridge-evidence-']);
    expect(ACCEPTED_EVIDENCE_VOLUME_PREFIXES).toEqual([
      'io-quarangate-evidence-',
      'io-mcp-ide-bridge-evidence-',
    ]);
  });

  it('keeps writer and reader on one source of truth', async () => {
    // beforeCapture physically creates the volume; evidenceCollector expires it.
    // A divergence here strands evidence as permanently undeletable.
    const writer = await import('../../src/executor/agents/beforeCapture.js');
    const reader = await import('../../src/executor/agents/evidenceCollector.js');
    expect(writer.evidenceVolumeName(JOB)).toBe(evidenceVolumeName(JOB));
    expect(reader.evidenceVolumeName(JOB)).toBe(evidenceVolumeName(JOB));
  });

  it('correlates a pre-cutover job recorded under the legacy name', () => {
    const legacyName = `io-mcp-ide-bridge-evidence-${JOB}`;
    expect(isAcceptedEvidenceVolumeName(legacyName, JOB)).toBe(true);
    expect(acceptedEvidenceVolumeNames(JOB)).toContain(legacyName);
  });

  it('correlates a post-cutover job recorded under the new name', () => {
    expect(isAcceptedEvidenceVolumeName(`io-quarangate-evidence-${JOB}`, JOB)).toBe(true);
  });

  it('refuses a name belonging to a DIFFERENT job in either family', () => {
    expect(isAcceptedEvidenceVolumeName(`io-quarangate-evidence-${OTHER_JOB}`, JOB)).toBe(false);
    expect(isAcceptedEvidenceVolumeName(`io-mcp-ide-bridge-evidence-${OTHER_JOB}`, JOB)).toBe(false);
  });

  it('refuses unrelated or near-miss names', () => {
    expect(isAcceptedEvidenceVolumeName('mcp-bridge-jobs', JOB)).toBe(false);
    expect(isAcceptedEvidenceVolumeName(`io-quarangate-ws-${JOB}`, JOB)).toBe(false);
    expect(isAcceptedEvidenceVolumeName(`evidence-${JOB}`, JOB)).toBe(false);
  });

  it('detects both evidence families by prefix, and nothing else', () => {
    expect(hasAcceptedEvidenceVolumePrefix(`io-quarangate-evidence-${JOB}`)).toBe(true);
    expect(hasAcceptedEvidenceVolumePrefix(`io-mcp-ide-bridge-evidence-${JOB}`)).toBe(true);
    expect(hasAcceptedEvidenceVolumePrefix(`io-quarangate-ws-${JOB}`)).toBe(false);
    expect(hasAcceptedEvidenceVolumePrefix('mcp-bridge-data')).toBe(false);
  });

  it('produces one deterministic candidate per accepted prefix (no duplicates)', () => {
    const names = acceptedEvidenceVolumeNames(JOB);
    expect(names).toHaveLength(ACCEPTED_EVIDENCE_VOLUME_PREFIXES.length);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// Target discovery namespace is deliberately NOT migrated (§47.4)
// ---------------------------------------------------------------------------

describe('target opt-in discovery labels', () => {
  it('still reads mcp.bridge.* (operator-authored, out-of-repo producers)', async () => {
    // Live targets are labelled by Compose files this repo does not own.
    // Migrating this namespace here would empty targets_list.
    const src = await import('node:fs/promises');
    const targets = await src.readFile(new URL('../../src/executor/targets.ts', import.meta.url), 'utf8');
    expect(targets).toContain("'mcp.bridge.enabled'");
    expect(targets).toContain("'mcp.bridge.workspace'");
    expect(targets).toContain("'mcp.bridge.name'");
  });
});
