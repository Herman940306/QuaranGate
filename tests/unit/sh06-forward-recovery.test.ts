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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluateRecoveryAdmission,
  type RecoveryAdmissionInput,
} from '../../src/operations/sh06ForwardRecovery.js';
import { evaluateSchemaPreflight } from '../../src/operations/sh06Recovery.js';

const root = resolve(import.meta.dirname, '../..');
const recoverySh = readFileSync(join(root, 'scripts/remote-owner-forward-recover-v9.sh'), 'utf8');
const deploySh   = readFileSync(join(root, 'scripts/remote-owner-deploy-candidate.sh'), 'utf8');
const rollbackSh = recoverySh.slice(
  recoverySh.indexOf('rollback() {'),
  recoverySh.indexOf('# ARM THE TRAP'),
);
const primaryRecoverySh = recoverySh.slice(
  recoverySh.indexOf('# SECTION 11 — STAGED SERVICE RECOVERY'),
  recoverySh.indexOf('# SECTION 12 — PRODUCT SMOKE'),
);

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
    const authorityUp = primaryRecoverySh.indexOf('up -d --no-deps --no-build --pull never docker-authority');
    const executorUp  = primaryRecoverySh.indexOf('up -d --no-deps --no-build --pull never executor');
    const authorityReady = primaryRecoverySh.indexOf('DOCKER_AUTHORITY_READY');
    expect(authorityUp,    'docker-authority up must exist').toBeGreaterThanOrEqual(0);
    expect(executorUp,     'executor up must exist').toBeGreaterThanOrEqual(0);
    expect(authorityReady, 'docker-authority ready marker must exist').toBeGreaterThanOrEqual(0);
    expect(authorityUp).toBeLessThan(executorUp);
    expect(authorityReady).toBeLessThan(executorUp);
  });

  it('explicitly stops and verifies the bound legacy executor before authority and replacement admission', () => {
    const capture = recoverySh.indexOf('LEGACY_EXECUTOR_CID="${live_executor_ids[0]}"');
    const stop = primaryRecoverySh.indexOf('docker stop "$LEGACY_EXECUTOR_CID"');
    const firstVerify = primaryRecoverySh.indexOf('verify_legacy_executor_quiesced');
    const authorityUp = primaryRecoverySh.indexOf('up -d --no-deps --no-build --pull never docker-authority');
    const authorityReady = primaryRecoverySh.indexOf("primary_authority_ready=1");
    const finalVerify = primaryRecoverySh.lastIndexOf('verify_legacy_executor_quiesced');
    const executorUp = primaryRecoverySh.indexOf('up -d --no-deps --no-build --pull never executor');
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(firstVerify).toBeGreaterThan(stop);
    expect(authorityUp).toBeGreaterThan(firstVerify);
    expect(authorityReady).toBeGreaterThan(authorityUp);
    expect(finalVerify).toBeGreaterThan(authorityReady);
    expect(executorUp).toBeGreaterThan(finalVerify);
  });

  it('binds quiescence to exact project, service, image, revision, ID, and non-running state', () => {
    expect(recoverySh).toContain('LEGACY_EXECUTOR_PROJECT');
    expect(recoverySh).toContain('LEGACY_EXECUTOR_SERVICE');
    expect(recoverySh).toContain('executor identity became ambiguous or changed');
    expect(recoverySh).toContain('captured executor identity drifted');
    expect(recoverySh).toContain("'{{.State.Running}}'");
    expect(recoverySh).toContain('ALL_RELEVANT_EXECUTORS_QUIESCED=YES');
  });

  it('does not admit R2 when primary authority never became ready', () => {
    expect(rollbackSh).toContain('[[ "$primary_authority_ready" == 1');
  });
});

// ---------------------------------------------------------------------------
// F9 — authority ready / executor fails → gateway never starts
// ---------------------------------------------------------------------------
describe('F9 executor failure blocks gateway', () => {
  it('recovery script starts executor before gateway', () => {
    const executorUp  = primaryRecoverySh.indexOf('up -d --no-deps --no-build --pull never executor');
    const gatewayUp   = primaryRecoverySh.indexOf('up -d --no-deps --no-build --pull never gateway');
    const executorReady = primaryRecoverySh.indexOf('EXECUTOR_READY');
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
    const gatewayUp    = primaryRecoverySh.indexOf('up -d --no-deps --no-build --pull never gateway');
    const gatewayReady = primaryRecoverySh.indexOf('GATEWAY_READY', gatewayUp);
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
    const executorReady = primaryRecoverySh.indexOf('EXECUTOR_READY');
    const schemaCheck   = primaryRecoverySh.indexOf('SCHEMA_MUTATION_DETECTED');
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
    const mutatedFlag = primaryRecoverySh.indexOf('persistent_state_may_have_mutated=1');
    const executorUp  = primaryRecoverySh.indexOf('up -d --no-deps --no-build --pull never executor');
    expect(mutatedFlag).toBeLessThan(executorUp);
  });

  it('refuses writable-volume restore unless every candidate writer is verified quiescent', () => {
    const quiescence = rollbackSh.indexOf('ROLLBACK_WRITERS_QUIESCED=YES');
    const restoreGuard = rollbackSh.indexOf('if [[ "$writers_quiesced" == YES ]]');
    const restore = rollbackSh.indexOf('restore /snapshot/agents.db /snapshot/manifest.json /jobs/agents.db');
    expect(quiescence).toBeGreaterThanOrEqual(0);
    expect(restoreGuard).toBeGreaterThan(quiescence);
    expect(restore).toBeGreaterThan(restoreGuard);
    expect(rollbackSh).toContain('persistent state restore refused because writer quiescence is unproven');
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

  it('verifies GitHub resources are absent and blocks fallback when cleanup is unproven', () => {
    expect(rollbackSh).toContain('ROLLBACK removed and verified absent recovery-created GitHub services');
    expect(rollbackSh).toContain('ROLLBACK GitHub cleanup FAILED or could not be verified');
    expect(rollbackSh).toContain('&& "$ROLLBACK_GITHUB_STATE" == YES && "$writers_quiesced" == YES');
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
    const configCommit    = recoverySh.indexOf('# SECTION 13 — RUNTIME CONFIG COMMIT');
    const envUpdated      = recoverySh.indexOf('persist_runtime_config', configCommit);
    expect(smokePass,       'PRODUCT_SMOKE_PASS=YES must exist').toBeGreaterThanOrEqual(0);
    expect(infraAcceptance, 'infra-acceptance call must exist').toBeGreaterThanOrEqual(0);
    expect(envUpdated,      'persist_runtime_config call must exist').toBeGreaterThanOrEqual(0);
    expect(smokePass).toBeLessThan(envUpdated);
    expect(infraAcceptance).toBeLessThan(configCommit);
  });

  it('RECOVERY_ACCEPTED printf appears after env_updated=1', () => {
    // Use the printf output marker (not the header comment)
    const envUpdated       = recoverySh.indexOf('persist_runtime_config', recoverySh.indexOf('# SECTION 13 — RUNTIME CONFIG COMMIT'));
    const recoveryAccepted = recoverySh.indexOf("printf 'RECOVERY_ACCEPTED=YES");
    expect(envUpdated).toBeGreaterThanOrEqual(0);
    expect(recoveryAccepted).toBeGreaterThan(envUpdated);
  });
});

describe('R1 remediation — production R2 fallback transaction', () => {
  it('binds exact accepted primary/R2/legacy image IDs and revisions', () => {
    expect(recoverySh).toContain("EXPECTED_PRIMARY_IMAGE_ID='sha256:2fe86e44ecc8bb85c1747ede467c92d865c35d503fe54f167deb2802fbd298fc'");
    expect(recoverySh).toContain("EXPECTED_FALLBACK_IMAGE_ID='sha256:720172e5c189398bd91e33e5fac1897f9e98f260d00a86a3d6e24656f55bd9f7'");
    expect(recoverySh).toContain("EXPECTED_LEGACY_IMAGE_ID='sha256:8457dcea1a00253fb6b09183d9bc21b2d50f6aef0e81e1845cebc3f7854bdfa0'");
    expect(recoverySh).toContain('[[ "$PRIMARY_IMAGE_ID" == "$EXPECTED_PRIMARY_IMAGE_ID" ]]');
    expect(recoverySh).toContain('[[ "$FALLBACK_IMAGE_ID" == "$EXPECTED_FALLBACK_IMAGE_ID" ]]');
    expect(recoverySh).toContain('[[ "$LEGACY_EXECUTOR_IMAGE_ID" == "$EXPECTED_LEGACY_IMAGE_ID" ]]');
    expect(recoverySh).toContain("EXPECTED_PRIMARY_REV='42d226803bfbc073f10570ed7f8579d3f19baa2f'");
    expect(recoverySh).toContain('[[ "$PRIMARY_REV" == "$EXPECTED_PRIMARY_REV" ]]');
    expect(recoverySh).toContain("EXPECTED_FALLBACK_REV='bd1a8a3f732b55515bca5e452140de132f3fb6d3'");
    expect(recoverySh).toContain('[[ "$FALLBACK_REV" == "$EXPECTED_FALLBACK_REV" ]]');
    expect(recoverySh).toContain("EXPECTED_LEGACY_REV='a7a61c1ef1949180dd544f557999ebc328800321'");
    expect(recoverySh).toContain('[[ "$LEGACY_EXECUTOR_REV" == "$EXPECTED_LEGACY_REV" ]]');
  });

  it('restores verified v9 state before staged fallback authority/executor/gateway startup', () => {
    const restore = rollbackSh.indexOf('restore /snapshot/agents.db /snapshot/manifest.json /jobs/agents.db');
    const authority = rollbackSh.indexOf('up -d --no-deps --no-build --pull never docker-authority', restore);
    const executor = rollbackSh.indexOf('up -d --no-deps --no-build --pull never executor', authority);
    const gateway = rollbackSh.indexOf('up -d --no-deps --no-build --pull never gateway', executor);
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(authority).toBeGreaterThan(restore);
    expect(executor).toBeGreaterThan(authority);
    expect(gateway).toBeGreaterThan(executor);
  });

  it('requires exact fallback image IDs, DB schema/integrity/FK proof, and persisted config', () => {
    expect(rollbackSh).toContain("'{{.Image}}')\" == \"$FALLBACK_IMAGE_ID\"");
    expect(rollbackSh).toContain('d.get("userVersion")==9');
    expect(rollbackSh).toContain('d.get("integrityCheck")=="ok"');
    expect(rollbackSh).toContain('d.get("foreignKeyViolations")==0');
    expect(rollbackSh).toContain('persist_runtime_config');
    expect(rollbackSh).toContain('verify_runtime_config');
  });

  it('returns critical failure whenever post-mutation R2 fallback is not ready', () => {
    expect(rollbackSh).toContain('"$runtime_mutated" == 1 && "$fallback_ready" != YES');
    expect(rollbackSh).toContain('FORWARD_RECOVERY_FAILED=CRITICAL_FORWARD_RECOVERY_FAILED');
    expect(rollbackSh).toContain('CRITICAL_INVARIANT: DO NOT START LEGACY v7 EXECUTOR');
    expect(rollbackSh).not.toContain('legacy executor restarting) will resume automatically');
    expect(rollbackSh).toContain('ROLLBACK_PARTIAL_R2_QUIESCED=YES');
    expect(rollbackSh).toContain('ROLLBACK_PARTIAL_R2_QUIESCED=NO');
  });

  it('executes actual production shell: primary failure restores v9 then admits exact R2 fallback', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'qg-sh06-forward-shell-'));
    try {
      const bin = join(fixture, 'bin');
      const runtime = join(fixture, 'runtime');
      const state = join(fixture, 'state');
      const projects = join(fixture, 'projects');
      for (const path of [bin, runtime, join(runtime, 'config'), state, projects]) mkdirSync(path, { recursive: true });
      writeFileSync(join(runtime, 'compose.yaml'), 'services: {}\n');
      writeFileSync(join(runtime, 'config', 'clients.yaml'), 'clients: []\n');
      writeFileSync(join(runtime, 'config', 'bridge.yaml'), 'discovery:\n  enabled: false\ntargets: []\n');
      writeFileSync(join(runtime, '.env'), [
        'INTERNAL_TOKEN=test-internal-token',
        'GATEWAY_IMAGE=legacy-gateway',
        'DOCKER_AUTHORITY_IMAGE=legacy-authority',
        'EXECUTOR_IMAGE=legacy-executor',
        '',
      ].join('\n'), { mode: 0o600 });

      const gitShim = String.raw`#!/usr/bin/env bash
set -eu
case "$*" in
  'rev-parse HEAD') echo 1111111111111111111111111111111111111111 ;;
  'branch --show-current') echo fix/sh06-current-v9-forward-recovery-gpt ;;
  'status --porcelain') ;;
  *) exit 2 ;;
esac
`;
      writeFileSync(join(bin, 'git'), gitShim, { mode: 0o700 });

      const dockerShim = String.raw`#!/usr/bin/env bash
set -e
primary=sha256:2fe86e44ecc8bb85c1747ede467c92d865c35d503fe54f167deb2802fbd298fc
fallback=sha256:720172e5c189398bd91e33e5fac1897f9e98f260d00a86a3d6e24656f55bd9f7
legacy=sha256:8457dcea1a00253fb6b09183d9bc21b2d50f6aef0e81e1845cebc3f7854bdfa0
log="$QG_FAKE_STATE/docker.log"
cmd="$1"; shift
service_from_args() {
  for arg in "$@"; do
    case "$arg" in
      *com.docker.compose.service=*) echo "$arg" | sed 's/.*=//' ; return ;;
    esac
  done
}
container_mode() {
  case "$1" in
    legacy-*) echo legacy ;;
    primary-*) echo primary ;;
    fallback-*) echo fallback ;;
    *) echo unknown ;;
  esac
}
case "$cmd" in
  info) exit 0 ;;
  image)
    sub="$1"; ref="$2"; shift 2
    [ "$sub" = inspect ] || exit 2
    fmt=''
    while [ "$#" -gt 0 ]; do [ "$1" = --format ] && fmt="$2" && break; shift; done
    case "$ref" in
      *720172e5*|*fallback*|*r2-review*) id="$fallback"; rev=bd1a8a3f732b55515bca5e452140de132f3fb6d3 ;;
      *8457dcea*|*a7a61c1*|*legacy*) id="$legacy"; rev=a7a61c1ef1949180dd544f557999ebc328800321 ;;
      *) id="$primary"; rev=42d226803bfbc073f10570ed7f8579d3f19baa2f ;;
    esac
    case "$fmt" in *revision*) echo "$rev" ;; *) echo "$id" ;; esac
    ;;
  ps)
    service="$(service_from_args "$@")"
    [ -n "$service" ] || exit 0
    printf 'DISCOVER|%s\n' "$service" >>"$log"
    if [ -f "$QG_FAKE_STATE/$service" ]; then cat "$QG_FAKE_STATE/$service"; exit 0; fi
    [ ! -f "$QG_FAKE_STATE/$service-replaced" ] || exit 0
    case "$service" in
      executor)
        echo legacy-executor
        [ "$QG_SECOND_EXECUTOR_PRESENT" != 1 ] || echo unrelated-project-executor
        ;;
      gateway) echo legacy-gateway ;;
    esac
    ;;
  inspect)
    cid="$1"; shift
    fmt=''
    while [ "$#" -gt 0 ]; do [ "$1" = --format ] && fmt="$2" && break; shift; done
    mode="$(container_mode "$cid")"
    case "$fmt" in
      *com.docker.compose.project*)
        if [ "$cid" = legacy-executor ] && [ "$QG_AMBIGUOUS_EXECUTOR_IDENTITY" = 1 ]; then echo wrong-project; else echo quarangate; fi
        ;;
      *com.docker.compose.service*) echo executor ;;
      *org.opencontainers.image.revision*)
        case "$mode" in
          legacy) echo a7a61c1ef1949180dd544f557999ebc328800321 ;;
          fallback) echo bd1a8a3f732b55515bca5e452140de132f3fb6d3 ;;
          *) echo 42d226803bfbc073f10570ed7f8579d3f19baa2f ;;
        esac
        ;;
      *'.Image'*) case "$mode" in legacy) echo "$legacy" ;; primary) echo "$primary" ;; fallback) echo "$fallback" ;; esac ;;
      *'.State.Running'*)
        printf 'INSPECT_RUNNING|%s\n' "$cid" >>"$log"
        case "$cid" in
          legacy-executor)
            if [ -f "$QG_FAKE_STATE/legacy-stopped" ] && [ "$QG_STILL_RUNNING_AFTER_STOP" != 1 ]; then echo false; else echo true; fi
            ;;
          unrelated-project-executor) echo true ;;
          *) echo true ;;
        esac
        ;;
      *'.State.Status'*)
        case "$cid" in
          legacy-executor)
            if [ -f "$QG_FAKE_STATE/legacy-stopped" ] && [ "$QG_STILL_RUNNING_AFTER_STOP" != 1 ]; then echo exited; else echo restarting; fi
            ;;
          *) echo running ;;
        esac
        ;;
      *'.State.Health'*)
        printf 'READY_CHECK|%s\n' "$cid" >>"$log"
        case "$cid" in
          legacy-gateway) echo unhealthy ;;
          primary-gateway) [ "$QG_PRIMARY_GATEWAY_HEALTHY" = 1 ] && echo healthy || echo unhealthy ;;
          primary-github-broker) [ "$QG_FAIL_GITHUB_BROKER" = 1 ] && echo unhealthy || echo healthy ;;
          fallback-gateway) [ "$QG_FAIL_FALLBACK_GATEWAY" = 1 ] && echo unhealthy || echo healthy ;;
          *) echo healthy ;;
        esac
        ;;
      *'.Mounts'*) echo '[]' ;;
      *PortBindings*) echo '{}' ;;
      *) echo '{}' ;;
    esac
    ;;
  network|volume) [ "$1" = inspect ] ;;
  tag) printf 'TAG|%s|%s\n' "$1" "$2" >>"$log" ;;
  compose)
    action=''; service=''
    for arg in "$@"; do
      case "$arg" in up|stop) action="$arg" ;; docker-authority|executor|gateway|github-egress-proxy|github-broker) service="$arg" ;; esac
    done
    if [ "$action" = stop ]; then
      if [ "$QG_FAIL_COMPOSE_STOP" = 1 ]; then
        printf 'STOP_FAILED|primary-services\n' >>"$log"
        exit 1
      fi
      rm -f "$QG_FAKE_STATE/docker-authority" "$QG_FAKE_STATE/executor" "$QG_FAKE_STATE/gateway"
      printf 'STOP|primary-services\n' >>"$log"
      exit 0
    fi
    [ "$action" = up ] || exit 0
    touch "$QG_FAKE_STATE/operation-started"
    case "$service" in
      docker-authority) image="$DOCKER_AUTHORITY_IMAGE" ;;
      executor) image="$EXECUTOR_IMAGE" ;;
      gateway) image="$GATEWAY_IMAGE" ;;
      github-egress-proxy|github-broker) image=primary ;;
    esac
    case "$image" in *fallback*) mode=fallback ;; *) mode=primary ;; esac
    if [ "$service" = docker-authority ] && [ "$QG_FAIL_AUTHORITY_UP" = 1 ]; then
      printf 'UP_FAILED|%s|%s\n' "$mode" "$service" >>"$log"
      exit 1
    fi
    case "$service" in executor|gateway) touch "$QG_FAKE_STATE/$service-replaced" ;; esac
    echo "$mode-$service" >"$QG_FAKE_STATE/$service"
    printf 'UP|%s|%s\n' "$mode" "$service" >>"$log"
    ;;
  run)
    all="$*"
    case "$all" in
      */probe.mjs*) case "$all" in *8457dcea*) echo 7 ;; *) echo 9 ;; esac ;;
      *' restore '*) printf 'RUN|restore\n' >>"$log"; echo '{"status":"PERSISTENT_STATE_RESTORED","userVersion":9,"integrityCheck":"ok","foreignKeyViolations":0}' ;;
      *' verify '*) echo '{"status":"SNAPSHOT_VERIFIED","userVersion":9,"integrityCheck":"ok","foreignKeyViolations":0,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sizeBytes":4096}' ;;
      *' snapshot '*)
        snap=''
        for arg in "$@"; do case "$arg" in type=bind,src=*,dst=/snapshot*) snap="$(printf '%s' "$arg" | sed 's/type=bind,src=//;s/,dst=\/snapshot.*//')" ;; esac; done
        mkdir -p "$snap"
        case "$all" in
          *agents.db.fallback*) touch "$snap/agents.db.fallback" "$snap/manifest.fallback.json" ;;
          *) touch "$snap/agents.db" "$snap/manifest.json" ;;
        esac
        echo '{"status":"SNAPSHOT_VERIFIED","userVersion":9,"integrityCheck":"ok","foreignKeyViolations":0,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sizeBytes":4096}'
        ;;
      *) exit 2 ;;
    esac
    ;;
  stop|rm)
    cid="$1"
    printf '%s|%s\n' "$cmd" "$*" >>"$log"
    if [ "$cmd" = stop ] && [ "$cid" = legacy-executor ]; then
      [ "$QG_FAIL_LEGACY_STOP" != 1 ] || exit 1
      touch "$QG_FAKE_STATE/legacy-stopped"
      exit 0
    fi
    if [ "$QG_FAIL_GITHUB_CLEANUP" = 1 ]; then exit 1; fi
    case "$cid" in
      primary-github-broker) rm -f "$QG_FAKE_STATE/github-broker" ;;
      primary-github-egress-proxy) rm -f "$QG_FAKE_STATE/github-egress-proxy" ;;
    esac
    ;;
  *) exit 2 ;;
esac
`;
      writeFileSync(join(bin, 'docker'), dockerShim, { mode: 0o700 });
      chmodSync(join(bin, 'git'), 0o700);
      chmodSync(join(bin, 'docker'), 0o700);

      const resetRuntime = (): void => {
        rmSync(state, { recursive: true, force: true });
        mkdirSync(state, { recursive: true });
        rmSync(join(runtime, 'config', 'github.yaml'), { force: true });
        writeFileSync(join(runtime, '.env'), [
          'INTERNAL_TOKEN=test-internal-token',
          'GATEWAY_IMAGE=legacy-gateway',
          'DOCKER_AUTHORITY_IMAGE=legacy-authority',
          'EXECUTOR_IMAGE=legacy-executor',
          '',
        ].join('\n'), { mode: 0o600 });
      };
      const runRecovery = (overrides: Record<string, string> = {}) => spawnSync(
        'bash',
        [join(root, 'scripts', 'remote-owner-forward-recover-v9.sh')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            QG_FAKE_STATE: state,
            QG_FAIL_FALLBACK_GATEWAY: '0',
            QG_PRIMARY_GATEWAY_HEALTHY: '1',
            QG_FAIL_GITHUB_BROKER: '0',
            QG_FAIL_COMPOSE_STOP: '0',
            QG_FAIL_GITHUB_CLEANUP: '0',
            PROJECTS_ROOT: projects,
            QUARANGATE_RUNTIME_ROOT: runtime,
            QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE: 'quarangate:forensic-42d226803bfb',
            QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE: 'quarangate:r2-review-bd1a8a3f732b',
            ...overrides,
          },
        },
      );

      const dockerShimProbe = spawnSync(join(bin, 'docker'), ['info'], {
        encoding: 'utf8',
        env: { ...process.env, QG_FAKE_STATE: state },
      });
      expect(
        dockerShimProbe.status,
        `docker shim must accept info: error=${String(dockerShimProbe.error)} stdout=${dockerShimProbe.stdout} stderr=${dockerShimProbe.stderr}`,
      ).toBe(0);

      const result = spawnSync('bash', [join(root, 'scripts', 'remote-owner-forward-recover-v9.sh')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          QG_FAKE_STATE: state,
          QG_FAIL_FALLBACK_GATEWAY: '0',
          QG_PRIMARY_GATEWAY_HEALTHY: '0',
          QG_FAIL_GITHUB_BROKER: '0',
          QG_FAIL_COMPOSE_STOP: '0',
          QG_FAIL_GITHUB_CLEANUP: '0',
          PROJECTS_ROOT: projects,
          QUARANGATE_RUNTIME_ROOT: runtime,
          QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE: 'quarangate:forensic-42d226803bfb',
          QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE: 'quarangate:r2-review-bd1a8a3f732b',
        },
      });
      const combined = `${result.stdout}${result.stderr}`;
      expect(result.status, combined).toBe(0);
      expect(combined).toContain('FORWARD_RECOVERY=PASS_R2_FALLBACK');
      expect(combined).toContain('R2_FALLBACK_READY=YES');
      expect(combined).not.toContain('CRITICAL_FORWARD_RECOVERY_FAILED');
      expect(combined).toContain('LEGACY_EXECUTOR_START_ATTEMPTED=NO');

      const dockerLog = readFileSync(join(state, 'docker.log'), 'utf8');
      const legacyStop = dockerLog.indexOf('stop|legacy-executor');
      const legacyStoppedInspect = dockerLog.indexOf('INSPECT_RUNNING|legacy-executor', legacyStop);
      const primaryAuthority = dockerLog.indexOf('UP|primary|docker-authority');
      const primaryAuthorityReady = dockerLog.indexOf('READY_CHECK|primary-docker-authority');
      const primaryExecutor = dockerLog.indexOf('UP|primary|executor');
      const primaryGateway = dockerLog.indexOf('UP|primary|gateway');
      expect(legacyStop).toBeGreaterThanOrEqual(0);
      expect(legacyStoppedInspect).toBeGreaterThan(legacyStop);
      expect(primaryAuthority).toBeGreaterThan(legacyStoppedInspect);
      expect(primaryAuthorityReady).toBeGreaterThan(primaryAuthority);
      expect(primaryExecutor).toBeGreaterThan(primaryAuthorityReady);
      expect(primaryGateway).toBeGreaterThan(primaryExecutor);
      const restore = dockerLog.indexOf('RUN|restore');
      const authority = dockerLog.indexOf('UP|fallback|docker-authority');
      const executor = dockerLog.indexOf('UP|fallback|executor');
      const gateway = dockerLog.indexOf('UP|fallback|gateway');
      expect(restore).toBeGreaterThanOrEqual(0);
      expect(authority).toBeGreaterThan(restore);
      expect(executor).toBeGreaterThan(authority);
      expect(gateway).toBeGreaterThan(executor);
      expect(dockerLog).not.toContain('UP|legacy');

      const runtimeEnv = readFileSync(join(runtime, '.env'), 'utf8');
      expect(runtimeEnv).toContain('GATEWAY_IMAGE=quarangate:gateway-fallback-bd1a8a3f732b55515bca5e452140de132f3fb6d3');
      expect(runtimeEnv).toContain('GATEWAY_IMAGE_ID=sha256:720172e5c189398bd91e33e5fac1897f9e98f260d00a86a3d6e24656f55bd9f7');
      expect(runtimeEnv).toContain('EXECUTOR_IMAGE=quarangate:executor-fallback-bd1a8a3f732b55515bca5e452140de132f3fb6d3');

      rmSync(state, { recursive: true, force: true });
      mkdirSync(state, { recursive: true });
      writeFileSync(join(runtime, '.env'), [
        'INTERNAL_TOKEN=test-internal-token',
        'GATEWAY_IMAGE=legacy-gateway',
        'DOCKER_AUTHORITY_IMAGE=legacy-authority',
        'EXECUTOR_IMAGE=legacy-executor',
        '',
      ].join('\n'), { mode: 0o600 });
      const failedFallback = spawnSync('bash', [join(root, 'scripts', 'remote-owner-forward-recover-v9.sh')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          QG_FAKE_STATE: state,
          QG_FAIL_FALLBACK_GATEWAY: '1',
          QG_PRIMARY_GATEWAY_HEALTHY: '0',
          QG_FAIL_GITHUB_BROKER: '0',
          QG_FAIL_COMPOSE_STOP: '0',
          QG_FAIL_GITHUB_CLEANUP: '0',
          PROJECTS_ROOT: projects,
          QUARANGATE_RUNTIME_ROOT: runtime,
          QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE: 'quarangate:forensic-42d226803bfb',
          QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE: 'quarangate:r2-review-bd1a8a3f732b',
        },
      });
      const failedCombined = `${failedFallback.stdout}${failedFallback.stderr}`;
      expect(failedFallback.status, failedCombined).toBe(1);
      expect(failedCombined).toContain('FORWARD_RECOVERY_FAILED=CRITICAL_FORWARD_RECOVERY_FAILED');
      expect(failedCombined).toContain('LEGACY_EXECUTOR_START_ATTEMPTED=NO');
      expect(failedCombined).not.toContain('FORWARD_RECOVERY=PASS_R2_FALLBACK');
      expect(failedCombined).toContain('ROLLBACK_PARTIAL_R2_QUIESCED=YES');
      expect(existsSync(join(state, 'docker-authority'))).toBe(false);
      expect(existsSync(join(state, 'executor'))).toBe(false);
      expect(existsSync(join(state, 'gateway'))).toBe(false);

      rmSync(state, { recursive: true, force: true });
      mkdirSync(state, { recursive: true });
      writeFileSync(join(runtime, '.env'), [
        'INTERNAL_TOKEN=test-internal-token',
        'GATEWAY_IMAGE=legacy-gateway',
        'DOCKER_AUTHORITY_IMAGE=legacy-authority',
        'EXECUTOR_IMAGE=legacy-executor',
        '',
      ].join('\n'), { mode: 0o600 });
      const unquiescedWriter = spawnSync('bash', [join(root, 'scripts', 'remote-owner-forward-recover-v9.sh')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          QG_FAKE_STATE: state,
          QG_FAIL_COMPOSE_STOP: '1',
          QG_FAIL_GITHUB_CLEANUP: '0',
          QG_FAIL_FALLBACK_GATEWAY: '0',
          QG_PRIMARY_GATEWAY_HEALTHY: '0',
          QG_FAIL_GITHUB_BROKER: '0',
          PROJECTS_ROOT: projects,
          QUARANGATE_RUNTIME_ROOT: runtime,
          QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE: 'quarangate:forensic-42d226803bfb',
          QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE: 'quarangate:r2-review-bd1a8a3f732b',
        },
      });
      const unquiescedCombined = `${unquiescedWriter.stdout}${unquiescedWriter.stderr}`;
      expect(unquiescedWriter.status, unquiescedCombined).toBe(1);
      expect(unquiescedCombined).toContain('ROLLBACK_WRITERS_QUIESCED=NO');
      expect(unquiescedCombined).toContain('persistent state restore refused because writer quiescence is unproven');
      expect(unquiescedCombined).toContain('CRITICAL_FORWARD_RECOVERY_FAILED');
      const unquiescedLog = readFileSync(join(state, 'docker.log'), 'utf8');
      expect(unquiescedLog).not.toContain('RUN|restore');
      expect(unquiescedLog).not.toContain('UP|fallback');

      rmSync(state, { recursive: true, force: true });
      mkdirSync(state, { recursive: true });
      writeFileSync(join(runtime, '.env'), [
        'INTERNAL_TOKEN=test-internal-token',
        'GATEWAY_IMAGE=legacy-gateway',
        'DOCKER_AUTHORITY_IMAGE=legacy-authority',
        'EXECUTOR_IMAGE=legacy-executor',
        '',
      ].join('\n'), { mode: 0o600 });
      writeFileSync(join(runtime, 'config', 'github.yaml'), 'github:\n  enabled: true\n');
      const githubFailure = spawnSync('bash', [join(root, 'scripts', 'remote-owner-forward-recover-v9.sh')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          QG_FAKE_STATE: state,
          QG_FAIL_FALLBACK_GATEWAY: '0',
          QG_PRIMARY_GATEWAY_HEALTHY: '1',
          QG_FAIL_GITHUB_BROKER: '1',
          QG_FAIL_COMPOSE_STOP: '0',
          QG_FAIL_GITHUB_CLEANUP: '0',
          PROJECTS_ROOT: projects,
          QUARANGATE_RUNTIME_ROOT: runtime,
          QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE: 'quarangate:forensic-42d226803bfb',
          QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE: 'quarangate:r2-review-bd1a8a3f732b',
        },
      });
      const githubCombined = `${githubFailure.stdout}${githubFailure.stderr}`;
      expect(githubFailure.status, githubCombined).toBe(0);
      expect(githubCombined).toContain('FORWARD_RECOVERY=PASS_R2_FALLBACK');
      expect(githubCombined).toContain('ROLLBACK removed and verified absent recovery-created GitHub services');
      const githubLog = readFileSync(join(state, 'docker.log'), 'utf8');
      const proxyStop = githubLog.indexOf('stop|primary-github-egress-proxy');
      const brokerStop = githubLog.indexOf('stop|primary-github-broker');
      const githubFallback = githubLog.indexOf('UP|fallback|docker-authority');
      expect(proxyStop).toBeGreaterThanOrEqual(0);
      expect(brokerStop).toBeGreaterThanOrEqual(0);
      expect(githubFallback).toBeGreaterThan(proxyStop);
      expect(githubFallback).toBeGreaterThan(brokerStop);

      rmSync(state, { recursive: true, force: true });
      mkdirSync(state, { recursive: true });
      writeFileSync(join(runtime, '.env'), [
        'INTERNAL_TOKEN=test-internal-token',
        'GATEWAY_IMAGE=legacy-gateway',
        'DOCKER_AUTHORITY_IMAGE=legacy-authority',
        'EXECUTOR_IMAGE=legacy-executor',
        '',
      ].join('\n'), { mode: 0o600 });
      const githubCleanupFailure = spawnSync('bash', [join(root, 'scripts', 'remote-owner-forward-recover-v9.sh')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          QG_FAKE_STATE: state,
          QG_FAIL_FALLBACK_GATEWAY: '0',
          QG_PRIMARY_GATEWAY_HEALTHY: '1',
          QG_FAIL_GITHUB_BROKER: '1',
          QG_FAIL_COMPOSE_STOP: '0',
          QG_FAIL_GITHUB_CLEANUP: '1',
          PROJECTS_ROOT: projects,
          QUARANGATE_RUNTIME_ROOT: runtime,
          QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE: 'quarangate:forensic-42d226803bfb',
          QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE: 'quarangate:r2-review-bd1a8a3f732b',
        },
      });
      const githubCleanupCombined = `${githubCleanupFailure.stdout}${githubCleanupFailure.stderr}`;
      expect(githubCleanupFailure.status, githubCleanupCombined).toBe(1);
      expect(githubCleanupCombined).toContain('ROLLBACK GitHub cleanup FAILED or could not be verified');
      expect(githubCleanupCombined).toContain('CRITICAL_FORWARD_RECOVERY_FAILED');
      const githubCleanupLog = readFileSync(join(state, 'docker.log'), 'utf8');
      expect(githubCleanupLog).not.toContain('UP|fallback');

      for (const scenario of [
        { name: 'stop failure', env: { QG_FAIL_LEGACY_STOP: '1' }, expected: 'exact legacy executor stop failed', status: 1 },
        { name: 'still running', env: { QG_STILL_RUNNING_AFTER_STOP: '1' }, expected: 'captured executor is not quiescent', status: 1 },
        { name: 'second executor', env: { QG_SECOND_EXECUTOR_PRESENT: '1' }, expected: 'expected exactly 1 legacy executor container', status: 2 },
        { name: 'ambiguous identity', env: { QG_AMBIGUOUS_EXECUTOR_IDENTITY: '1' }, expected: 'legacy executor labels mismatch', status: 2 },
        { name: 'authority failure', env: { QG_FAIL_AUTHORITY_UP: '1' }, expected: 'docker-authority startup failed', status: 1 },
      ]) {
        resetRuntime();
        const failed = runRecovery(scenario.env);
        const failedOutput = `${failed.stdout}${failed.stderr}`;
        expect(failed.status, `${scenario.name}: ${failedOutput}`).toBe(scenario.status);
        expect(failedOutput).toContain(scenario.expected);
        const failureLog = readFileSync(join(state, 'docker.log'), 'utf8');
        expect(failureLog, scenario.name).not.toContain('UP|primary|executor');
        expect(failureLog, scenario.name).not.toContain('UP|primary|gateway');
        expect(failureLog, scenario.name).not.toContain('UP|fallback');
        expect(failureLog, scenario.name).not.toMatch(/stop\|(projects-work|owner-host-control|github|qualification)/u);
        if (scenario.name !== 'authority failure') {
          expect(failureLog, scenario.name).not.toContain('UP|primary|docker-authority');
        }
        expect(failureLog, scenario.name).not.toContain('UP|legacy');
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 15_000);
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
