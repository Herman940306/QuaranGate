import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';

const stores: AgentJobStore[] = [];
function open(path: string): AgentJobStore {
  const value = new AgentJobStore(path);
  stores.push(value);
  return value;
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch {}
  }
});

function replay(overrides: Partial<Parameters<AgentJobStore['claimSecurityAssessmentReplay']>[0]> = {}) {
  return {
    bridgeRequestId: `bar_${'a'.repeat(24)}`,
    nonce: 'b'.repeat(32),
    assessmentId: `assessment_${'c'.repeat(24)}`,
    assessmentVersion: 0,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    ...overrides,
  };
}

describe('BE9.2 durable admission replay ledger', () => {
  it('rejects the same request before restart', () => {
    const db = open(join(mkdtempSync(join(tmpdir(), 'be9-replay-')), 'agents.db'));
    const input = replay();
    expect(db.claimSecurityAssessmentReplay(input)).toBe(true);
    expect(db.claimSecurityAssessmentReplay(input)).toBe(false);
  });

  it('rejects the same request after Executor/Gateway restart while still inside TTL', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'be9-replay-restart-')), 'agents.db');
    const first = open(path);
    const input = replay();
    expect(first.claimSecurityAssessmentReplay(input)).toBe(true);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const restarted = open(path);
    expect(restarted.claimSecurityAssessmentReplay(input)).toBe(false);
  });

  it('treats nonce identity as globally single-use even when a different assessment/request tries to reuse it', () => {
    const db = open(join(mkdtempSync(join(tmpdir(), 'be9-replay-cross-')), 'agents.db'));
    const first = replay();
    expect(db.claimSecurityAssessmentReplay(first)).toBe(true);
    expect(db.claimSecurityAssessmentReplay(replay({
      bridgeRequestId: `bar_${'d'.repeat(24)}`,
      assessmentId: `assessment_${'e'.repeat(24)}`,
      nonce: first.nonce,
    }))).toBe(false);
  });

  it('does not admit an already expired replay identity', () => {
    const db = open(join(mkdtempSync(join(tmpdir(), 'be9-replay-expired-')), 'agents.db'));
    expect(db.claimSecurityAssessmentReplay(replay({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }))).toBe(false);
  });

  it('rejects malformed or oversized replay identity before persistence', () => {
    const db = open(join(mkdtempSync(join(tmpdir(), 'be9-replay-malformed-')), 'agents.db'));
    expect(() => db.claimSecurityAssessmentReplay(replay({
      bridgeRequestId: 'attacker',
    }))).toThrowError(expect.objectContaining({ code: 'MALFORMED_REQUEST' }));
    expect(() => db.claimSecurityAssessmentReplay(replay({
      nonce: 'f'.repeat(65),
    }))).toThrowError(expect.objectContaining({ code: 'MALFORMED_REQUEST' }));
  });
});
