/**
 * tests/unit/sh06-forward-recovery.test.ts
 *
 * SH-06 Current v9 Incident — Forward Recovery: failure-injection and
 * production-path admission tests (F1–F20, Section 18–19 of spec).
 *
 * Architecture:
 *   - All admission decisions execute through evaluateRecoveryAdmission()
 *     (src/operations/sh06ForwardRecovery.ts) — the single authoritative evaluator.
 *   - Standard deployment still uses evaluateSchemaPreflight() and must continue
 *     to DENY the 9/9/7 incident matrix.
 *   - Shell structural tests verify the recovery script encodes the evaluator
 *     call and the correct state-machine ordering.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  evaluateRecoveryAdmission,
  type RecoveryAdmissionInput,
} from '../../src/operations/sh06ForwardRecovery.js';
import { evaluateSchemaPreflight } from '../../src/operations/sh06Recovery.js';

const root = resolve(import.meta.dirname, '../..');
const recoverySh = readFileSync(join(root, 'scripts/remote-owner-forward-recover-v9.sh'), 'utf8');
const deploySh   = readFileSync(join(root, 'scripts/remote-owner-deploy-candidate.sh'), 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function admit(overrides: Partial<RecoveryAdmissionInput> = {}): ReturnType<typeof evaluateRecoveryAdmission> {
  const base: RecoveryAdmissionInput = {
    currentSchema:          9,
    primarySupportedSchema: 9,
    fallbackSupportedSchema: 9,
    legacySupportedSchema:  7,
    snapshotCreated:        true,
    snapshotVerified:       true,
    snapshotSchema:         9,
    ...overrides,
  };
  return evaluateRecoveryAdmission(base);
}

// ---------------------------------------------------------------------------
// F1 — incident state mismatch → no schema change; evaluator still runs
// (The precondition contract is in the shell; here we verify the evaluator
//  refuses an inconsistent schema combination.)
// ---------------------------------------------------------------------------
describe('F1 incident state mismatch (evaluator layer)', () => {
  it('denies when current schema does not match snapshot schema (M9 guard)', () => {
    const r = admit({ currentSchema: 9, snapshotSchema: 8 });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('SNAPSHOT_SCHEMA_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// F2 — current DB not 9 → abort
// ---------------------------------------------------------------------------
describe('F2 current DB schema not 9', () => {
  it('denies when current schema is not the v9 incident schema', () => {
    const r = admit({ currentSchema: 0, snapshotSchema: 0 });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('CURRENT_SCHEMA_NOT_V9_INCIDENT');
  });

  it('denies when current schema is 7 (old baseline) and fallback is 9', () => {
    const r = admit({ currentSchema: 7, snapshotSchema: 7, fallbackSupportedSchema: 9 });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('CURRENT_SCHEMA_NOT_V9_INCIDENT');
  });
});

// ---------------------------------------------------------------------------
// F3 — primary candidate schema < 9 → abort
// ---------------------------------------------------------------------------
describe('F3 primary candidate schema < current', () => {
  it('denies when primary supports only schema 8 and current is 9', () => {
    const r = admit({ primarySupportedSchema: 8 });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('CURRENT_SCHEMA_NEWER_THAN_CANDIDATE');
  });

  it('denies when primary supports schema 7 (legacy) and current is 9', () => {
    const r = admit({ primarySupportedSchema: 7 });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('CURRENT_SCHEMA_NEWER_THAN_CANDIDATE');
  });
});

// ---------------------------------------------------------------------------
// F4 — fallback schema < 9 → abort
// ---------------------------------------------------------------------------
describe('F4 fallback schema < current (critical v9-compatibility guard)', () => {
  it('denies when fallback supports schema 7 (legacy schema)', () => {
    const r = admit({ fallbackSupportedSchema: 7 });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('FALLBACK_SCHEMA_INCOMPATIBLE_WITH_V9_DATABASE');
    expect(r.fallbackQualified).toBe(false);
  });

  it('denies when fallback supports schema 8 (one short)', () => {
    const r = admit({ fallbackSupportedSchema: 8 });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('FALLBACK_SCHEMA_INCOMPATIBLE_WITH_V9_DATABASE');
  });

  it('denies when fallback supports schema 0', () => {
    const r = admit({ fallbackSupportedSchema: 0 });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('FALLBACK_SCHEMA_INCOMPATIBLE_WITH_V9_DATABASE');
  });
});

// ---------------------------------------------------------------------------
// F5 — no qualified fallback → abort before mutation
// ---------------------------------------------------------------------------
describe('F5 no qualified v9-compatible fallback', () => {
  it('denies with FALLBACK_SCHEMA_INCOMPATIBLE_WITH_V9_DATABASE when fallback is legacy', () => {
    const r = admit({ fallbackSupportedSchema: 7 });
    expect(r.verdict).toBe('DENY');
    expect(r.fallbackQualified).toBe(false);
  });

  it('denies when fallback schema is NaN', () => {
    const r = admit({ fallbackSupportedSchema: NaN });
    expect(r.verdict).toBe('DENY');
    expect(r.fallbackQualified).toBe(false);
  });

  it('denies when fallback schema is negative', () => {
    const r = admit({ fallbackSupportedSchema: -1 });
    expect(r.verdict).toBe('DENY');
    expect(r.fallbackQualified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F6 — snapshot not created → abort
// ---------------------------------------------------------------------------
describe('F6 snapshot not created', () => {
  it('denies when snapshot not created', () => {
    const r = admit({ snapshotCreated: false, snapshotVerified: false, snapshotSchema: undefined });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('SNAPSHOT_NOT_CREATED');
  });
});

// ---------------------------------------------------------------------------
// F7 — snapshot integrity failure (not verified)
// ---------------------------------------------------------------------------
describe('F7 snapshot not verified', () => {
  it('denies when snapshot created but not verified', () => {
    const r = admit({ snapshotCreated: true, snapshotVerified: false, snapshotSchema: undefined });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('SNAPSHOT_NOT_VERIFIED');
  });
});

// ---------------------------------------------------------------------------
// F8 — authority startup failure → executor never starts
// (structural: verify ordering in shell script)
// ---------------------------------------------------------------------------
describe('F8 docker-authority startup failure blocks executor', () => {
  it('recovery script starts docker-authority before executor', () => {
    const authorityUp = recoverySh.indexOf('up -d --no-deps --no-build --pull never docker-authority');
    const executorUp  = recoverySh.indexOf('up -d --no-deps --no-build --pull never executor');
    const authorityReady = recoverySh.indexOf('DOCKER_AUTHORITY_READY');
    expect(authorityUp,    'docker-authority up must exist').toBeGreaterThanOrEqual(0);
    expect(executorUp,     'executor up must exist').toBeGreaterThanOrEqual(0);
    expect(authorityReady, 'docker-authority ready marker must exist').toBeGreaterThanOrEqual(0);
    expect(authorityUp).toBeLessThan(executorUp);
    expect(authorityReady).toBeLessThan(executorUp);
  });
});

// ---------------------------------------------------------------------------
// F9 — authority ready / executor fails → gateway never starts
// ---------------------------------------------------------------------------
describe('F9 executor failure blocks gateway', () => {
  it('recovery script starts executor before gateway', () => {
    const executorUp  = recoverySh.indexOf('up -d --no-deps --no-build --pull never executor');
    const gatewayUp   = recoverySh.indexOf('up -d --no-deps --no-build --pull never gateway');
    const executorReady = recoverySh.indexOf('EXECUTOR_READY');
    expect(executorReady).toBeGreaterThanOrEqual(0);
    expect(executorReady).toBeLessThan(gatewayUp);
    expect(executorUp).toBeLessThan(gatewayUp);
  });
});

// ---------------------------------------------------------------------------
// F10 — gateway failure → correctly classified
// ---------------------------------------------------------------------------
describe('F10 gateway failure classification', () => {
  it('GATEWAY_READY marker exists after gateway readiness wait', () => {
    const gatewayUp    = recoverySh.indexOf('up -d --no-deps --no-build --pull never gateway');
    const gatewayReady = recoverySh.indexOf('GATEWAY_READY', gatewayUp);
    expect(gatewayUp).toBeGreaterThanOrEqual(0);
    expect(gatewayReady).toBeGreaterThan(gatewayUp);
  });
});

// ---------------------------------------------------------------------------
// F11 — DB changes after executor startup → recovery fails
// ---------------------------------------------------------------------------
describe('F11 DB schema mutation after executor startup', () => {
  it('recovery script checks schema after executor startup and fails on mismatch', () => {
    expect(recoverySh).toContain('SCHEMA_MUTATION_DETECTED');
    expect(recoverySh).toContain("fail 'SCHEMA_MUTATION_DETECTED: post-executor schema proof unavailable'");
    expect(recoverySh).toContain("fail 'SCHEMA_MUTATION_DETECTED: post-gateway schema proof unavailable'");
    // EXECUTOR_READY is set, then schema probe runs, then SCHEMA_MUTATION_DETECTED fail() is downstream
    const executorReady = recoverySh.indexOf('EXECUTOR_READY');
    const schemaCheck   = recoverySh.indexOf('SCHEMA_MUTATION_DETECTED');
    // Both must exist and schema check must come after EXECUTOR_READY state assignment
    expect(executorReady).toBeGreaterThanOrEqual(0);
    expect(schemaCheck).toBeGreaterThan(executorReady);
  });
});

// ---------------------------------------------------------------------------
// F12 — snapshot restore after post-executor failure restores exact v9 state
// ---------------------------------------------------------------------------
describe('F12 snapshot restore in rollback after executor starts', () => {
  it('rollback function restores from snapshot when persistent state may have mutated', () => {
    expect(recoverySh).toContain('persistent_state_may_have_mutated=1');
    expect(recoverySh).toContain('restore /snapshot/agents.db /snapshot/manifest.json /jobs/agents.db');
    expect(recoverySh).toContain('ROLLBACK_PERSISTENT_STATE=YES');
    expect(recoverySh).toContain('PERSISTENT_STATE_RESTORED');
    // persistent_state_may_have_mutated is set before executor up
    const mutatedFlag = recoverySh.indexOf('persistent_state_may_have_mutated=1');
    const executorUp  = recoverySh.indexOf('up -d --no-deps --no-build --pull never executor');
    expect(mutatedFlag).toBeLessThan(executorUp);
  });
});

// ---------------------------------------------------------------------------
// F13 — fallback startup uses schema>=9 image only (evaluator layer)
// ---------------------------------------------------------------------------
describe('F13 fallback must be schema >= 9', () => {
  it('allows when fallback is exactly schema 9', () => {
    const r = admit({ fallbackSupportedSchema: 9 });
    expect(r.verdict).toBe('ALLOW');
    expect(r.fallbackQualified).toBe(true);
  });

  it('allows when fallback supports schema 10 (future-proof)', () => {
    const r = admit({ fallbackSupportedSchema: 10 });
    expect(r.verdict).toBe('ALLOW');
    expect(r.fallbackQualified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F14 — attempted legacy v7 fallback is hard-denied
// ---------------------------------------------------------------------------
describe('F14 legacy v7 fallback is hard-denied', () => {
  it('denies v7 fallback unconditionally even with verified snapshot', () => {
    const r = admit({ fallbackSupportedSchema: 7, snapshotCreated: true, snapshotVerified: true });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('FALLBACK_SCHEMA_INCOMPATIBLE_WITH_V9_DATABASE');
  });

  it('recovery script never starts legacy executor in rollback', () => {
    expect(recoverySh).toContain('LEGACY_EXECUTOR_START_ATTEMPTED=NO');
    // Hard denial invariant must appear in the critical failure path
    expect(recoverySh).toContain('CRITICAL_INVARIANT: DO NOT START LEGACY v7 EXECUTOR');
  });

  it('recovery script rejects fallback that is the legacy executor image', () => {
    expect(recoverySh).toContain('FALLBACK_IS_LEGACY_EXECUTOR');
  });
});

// ---------------------------------------------------------------------------
// F15 — GitHub services absent baseline → recovery-created services cleaned
// ---------------------------------------------------------------------------
describe('F15 GitHub absent baseline — cleanup of recovery-created services', () => {
  it('rollback removes only recovery-created GitHub services when baseline was absent', () => {
    // REMOVE_CANDIDATE_CREATED path is documented in the rollback block
    expect(recoverySh).toContain('REMOVE_CANDIDATE_CREATED');
    expect(recoverySh).toContain('github_services_created=1');
    // Rollback block checks the flag before removing services
    expect(recoverySh).toContain('"$github_services_created" == 1');
    // The initial value is 0 (absent baseline assumption)
    expect(recoverySh).toContain('github_services_created=0');
  });
});

// ---------------------------------------------------------------------------
// F16 — token never printed
// ---------------------------------------------------------------------------
describe('F16 token never printed to stdout or stderr', () => {
  it('recovery script never echoes DOCKER_AUTHORITY_TOKEN_VALUE', () => {
    expect(recoverySh).not.toMatch(/printf[^\n]*DOCKER_AUTHORITY_TOKEN_VALUE/u);
    expect(recoverySh).not.toMatch(/echo[^\n]*DOCKER_AUTHORITY_TOKEN_VALUE/u);
  });

  it('recovery script never echoes INTERNAL_TOKEN_VALUE', () => {
    expect(recoverySh).not.toMatch(/printf[^\n]*INTERNAL_TOKEN_VALUE/u);
    expect(recoverySh).not.toMatch(/echo[^\n]*INTERNAL_TOKEN_VALUE/u);
  });

  it('recovery script marks SECRET_OUTPUT=NO in final output', () => {
    expect(recoverySh).toContain('SECRET_OUTPUT=NO');
  });
});

// ---------------------------------------------------------------------------
// F17 — .env commit failure → prior config restored
// ---------------------------------------------------------------------------
describe('F17 .env commit failure — rollback restores prior config', () => {
  it('rollback restores .env from backup when env_updated=1', () => {
    expect(recoverySh).toContain("env_updated\" == 1");
    expect(recoverySh).toContain('cp "$env_backup" "$RUNTIME_ENV"');
    expect(recoverySh).toContain('ROLLBACK_CONFIG_STATE=YES');
  });

  it('env backup is created after trap is armed', () => {
    const trapPos   = recoverySh.indexOf('trap rollback EXIT');
    const mktempPos = recoverySh.indexOf('env_backup="$(mktemp)"');
    const chmodPos  = recoverySh.indexOf('chmod 0600 "$env_backup"');
    const cpPos     = recoverySh.indexOf('cp "$RUNTIME_ENV" "$env_backup"');
    expect(trapPos,   'trap must exist').toBeGreaterThanOrEqual(0);
    expect(mktempPos, 'mktemp must exist').toBeGreaterThanOrEqual(0);
    expect(trapPos).toBeLessThan(mktempPos);
    expect(chmodPos).toBeGreaterThan(mktempPos);
    expect(cpPos).toBeGreaterThan(chmodPos);
  });
});

// ---------------------------------------------------------------------------
// F18 — full success: .env committed only at intended transaction point
// ---------------------------------------------------------------------------
describe('F18 .env committed only after all acceptance gates', () => {
  it('env_updated=1 is set only after product smoke and infra-acceptance pass', () => {
    const smokePass       = recoverySh.indexOf('PRODUCT_SMOKE_PASS=YES');
    const infraAcceptance = recoverySh.indexOf('remote-owner-infra-acceptance.sh');
    const envUpdated      = recoverySh.indexOf('env_updated=1');
    expect(smokePass,       'PRODUCT_SMOKE_PASS=YES must exist').toBeGreaterThanOrEqual(0);
    expect(infraAcceptance, 'infra-acceptance call must exist').toBeGreaterThanOrEqual(0);
    expect(envUpdated,      'env_updated=1 must exist').toBeGreaterThanOrEqual(0);
    expect(smokePass).toBeLessThan(envUpdated);
    expect(infraAcceptance).toBeLessThan(envUpdated);
  });

  it('RECOVERY_ACCEPTED printf appears after env_updated=1', () => {
    // Use the printf output marker (not the header comment)
    const envUpdated       = recoverySh.indexOf('env_updated=1');
    const recoveryAccepted = recoverySh.indexOf("printf 'RECOVERY_ACCEPTED=YES");
    expect(envUpdated).toBeGreaterThanOrEqual(0);
    expect(recoveryAccepted).toBeGreaterThan(envUpdated);
  });
});

// ---------------------------------------------------------------------------
// F19 — accepted standard deploy still DENIES 9/9/7
// (R2 regression — evaluateSchemaPreflight must not have been weakened)
// ---------------------------------------------------------------------------
describe('F19 standard deployment still DENIES 9/9/7 (R2 regression)', () => {
  it('evaluateSchemaPreflight returns DENY for current=9 candidate=9 rollback=7', () => {
    const r = evaluateSchemaPreflight({
      currentSchema:          9,
      candidateSupportedSchema: 9,
      rollbackSupportedSchema:  7,
      snapshotCreated:  true,
      snapshotVerified: true,
      snapshotSchema:   9,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
  });

  it('deploy script still contains Rule B gate string', () => {
    expect(deploySh).toContain('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
  });

  it('deploy script Rule B gate precedes every mutation marker', () => {
    const ruleB       = deploySh.indexOf('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
    const mutatedFlag = deploySh.indexOf('runtime_mutated=1');
    const authorityUp = deploySh.indexOf('up -d --no-deps --no-build --pull never docker-authority');
    const executorUp  = deploySh.indexOf('up -d --no-deps --no-build --pull never executor');
    expect(ruleB,       'Rule B must exist in deploy script').toBeGreaterThanOrEqual(0);
    expect(mutatedFlag, 'runtime_mutated=1 must exist').toBeGreaterThanOrEqual(0);
    expect(ruleB).toBeLessThan(mutatedFlag);
    expect(ruleB).toBeLessThan(authorityUp);
    expect(ruleB).toBeLessThan(executorUp);
  });
});

// ---------------------------------------------------------------------------
// F20 — recovery path ALLOWS 9/9/9 (current_db=9, primary=9, fallback=9)
// while standard deploy DENIES 9/9/7
// ---------------------------------------------------------------------------
describe('F20 recovery admission ALLOWS current=9/primary=9/fallback=9', () => {
  it('evaluateRecoveryAdmission ALLOW for incident matrix 9/9/9/7', () => {
    const r = admit();
    expect(r.verdict).toBe('ALLOW');
    expect(r.reason).toBe('RECOVERY_ADMISSION_OK');
    expect(r.fallbackQualified).toBe(true);
    expect(r.legacyFallbackBlocked).toBe(true);
  });

  it('evaluateRecoveryAdmission DENY for fallback=7 (standard-deploy equivalent)', () => {
    const r = admit({ fallbackSupportedSchema: 7 });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('FALLBACK_SCHEMA_INCOMPATIBLE_WITH_V9_DATABASE');
  });

  it('evaluateSchemaPreflight still DENY for standard-deploy 9/9/7', () => {
    const r = evaluateSchemaPreflight({
      currentSchema: 9, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
      snapshotCreated: true, snapshotVerified: true, snapshotSchema: 9,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
  });
});

// ---------------------------------------------------------------------------
// Production-path end-to-end admission proof (Section 19 of spec)
// ---------------------------------------------------------------------------
describe('Production-path end-to-end admission (Section 19)', () => {
  it('E2E-1 incident=9/primary=9/fallback=9/legacy=7 → ALLOW', () => {
    const r = evaluateRecoveryAdmission({
      currentSchema: 9, primarySupportedSchema: 9, fallbackSupportedSchema: 9,
      legacySupportedSchema: 7, snapshotCreated: true, snapshotVerified: true, snapshotSchema: 9,
    });
    expect(r.verdict).toBe('ALLOW');
    expect(r.reason).toBe('RECOVERY_ADMISSION_OK');
    expect(r.fallbackQualified).toBe(true);
    expect(r.legacyFallbackBlocked).toBe(true);
    expect(r.preflightResult.allowed).toBe(true);
  });

  it('E2E-2 incident=9/primary=9/fallback=7 → DENY (fallback not v9-compatible)', () => {
    const r = evaluateRecoveryAdmission({
      currentSchema: 9, primarySupportedSchema: 9, fallbackSupportedSchema: 7,
      legacySupportedSchema: 7, snapshotCreated: true, snapshotVerified: true, snapshotSchema: 9,
    });
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toBe('FALLBACK_SCHEMA_INCOMPATIBLE_WITH_V9_DATABASE');
    expect(r.fallbackQualified).toBe(false);
  });

  it('E2E-3 standard deploy 9/9/7 → DENY via evaluateSchemaPreflight', () => {
    const r = evaluateSchemaPreflight({
      currentSchema: 9, candidateSupportedSchema: 9, rollbackSupportedSchema: 7,
      snapshotCreated: true, snapshotVerified: true, snapshotSchema: 9,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE');
  });

  it('E2E-4 recovery path is separate from standard deploy — different entry points', () => {
    // Standard deploy script must NOT contain forward-recovery admission call
    expect(deploySh).not.toContain('sh06ForwardRecovery');
    expect(deploySh).not.toContain('QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE');
    // Recovery script must call the forward recovery evaluator
    expect(recoverySh).toContain('sh06ForwardRecovery.js');
    expect(recoverySh).toContain('QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE');
    // Recovery script must not invoke standard deploy as a subprocess
    expect(recoverySh).not.toContain('remote-owner-deploy-candidate.sh');
  });
});

// ---------------------------------------------------------------------------
// Recovery state machine ordering (Section 10 of spec)
// ---------------------------------------------------------------------------
describe('Recovery state machine ordering', () => {
  it('state machine follows required sequence', () => {
    const states = [
      'INCIDENT_VERIFIED',
      'V9_SNAPSHOT_VERIFIED',
      'RECOVERY_TOKEN_PREPARED_IN_MEMORY',
      'DOCKER_AUTHORITY_READY',
      'EXECUTOR_READY',
      'GATEWAY_READY',
      'PRODUCT_SMOKE_PASS',
      'RUNTIME_CONFIG_COMMITTED',
      'RECOVERY_ACCEPTED',
    ];
    let prev = 0;
    for (const state of states) {
      const pos = recoverySh.indexOf(state, prev);
      expect(pos, `state ${state} must appear after previous state`).toBeGreaterThan(prev);
      prev = pos;
    }
  });
});

// ---------------------------------------------------------------------------
// Shell structural invariants
// ---------------------------------------------------------------------------
describe('Shell structural invariants', () => {
  it('recovery script requires all three mandatory env vars', () => {
    expect(recoverySh).toContain('QUARANGATE_RUNTIME_ROOT');
    expect(recoverySh).toContain('QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE');
    expect(recoverySh).toContain('QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE');
  });

  it('recovery script verifies FALLBACK_IS_LEGACY_EXECUTOR hard denial', () => {
    expect(recoverySh).toContain('FALLBACK_IS_LEGACY_EXECUTOR');
  });

  it('recovery script verifies INCIDENT_STATE_MISMATCH string', () => {
    expect(recoverySh).toContain('INCIDENT_STATE_MISMATCH');
  });

  it('recovery script does not contain docker pull', () => {
    expect(recoverySh).not.toMatch(/docker\s+pull/u);
  });

  it('recovery script does not contain --force or --skip-schema-check flags', () => {
    // These flags must never appear as option arguments
    expect(recoverySh).not.toMatch(/\s--force\b/u);
    expect(recoverySh).not.toContain('--skip-schema-check');
    expect(recoverySh).not.toContain('ALLOW_UNSAFE');
    expect(recoverySh).not.toContain('IGNORE_ROLLBACK_SCHEMA');
  });

  it('recovery script does not invoke standard deployment script as subprocess', () => {
    expect(recoverySh).not.toContain('remote-owner-deploy-candidate.sh');
  });

  it('recovery script calls the TypeScript evaluator for admission', () => {
    // Use the variable assignment that holds the evaluator path — appears after snapshot
    const evalCall = recoverySh.indexOf('node "$EVALUATOR_JS"');
    expect(evalCall, 'evaluator node call must exist').toBeGreaterThanOrEqual(0);
    // evaluator call must appear after snapshot verification
    const snapshotVerified = recoverySh.indexOf('snapshot_verified=1');
    expect(evalCall).toBeGreaterThan(snapshotVerified);
    // evaluator call must appear before runtime_mutated=1
    const mutated = recoverySh.indexOf('runtime_mutated=1');
    expect(evalCall).toBeLessThan(mutated);
  });
});
