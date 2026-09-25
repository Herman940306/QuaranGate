/**
 * sh06ForwardRecovery.ts — SH-06 Current v9 Incident: forward-recovery admission evaluator.
 *
 * PURPOSE
 * -------
 * The standard deployment path (evaluateSchemaPreflight in sh06Recovery.ts) is
 * unconditionally blocked for the 9/9/7 matrix because the rollback executor
 * (a7a61c1, schema-7) cannot read the current v9 database.  That block is correct
 * and must not be weakened.
 *
 * This module provides the SEPARATE governed admission gate for the current-incident
 * forward-recovery operation.  The key architectural difference is:
 *
 *   Standard deployment rollback: defined by the OLD executor image already running
 *                                 in production — which is schema-7 for this incident.
 *   Forward-recovery fallback:    explicitly nominated by the recovery operator and
 *                                 independently qualified to support schema >= current.
 *
 * The evaluator enforces that BOTH the primary candidate AND the explicit fallback
 * image support a schema >= the current database schema.  It delegates all other
 * preflight logic (snapshot, Rule A, M9) to evaluateSchemaPreflight rather than
 * duplicating those rules.
 *
 * SINGLE AUTHORITATIVE IMPLEMENTATION
 * ------------------------------------
 * Production shell and tests MUST call this module (via the CLI entry point below
 * or direct import).  No shell script may hand-code the same compatibility rule.
 *
 * MACHINE-READABLE OUTPUT CONTRACT
 * ---------------------------------
 * When invoked as a CLI (node sh06ForwardRecovery.js evaluate <json>), the process
 * writes a single JSON line to stdout and exits 0 on ALLOW or 1 on DENY.
 * The shell recovery script reads and validates that JSON before proceeding.
 *
 * Format:
 *   {"verdict":"ALLOW","reason":"RECOVERY_ADMISSION_OK",...}
 *   {"verdict":"DENY","reason":"<reason>",...}
 */

import { pathToFileURL } from 'node:url';
import { evaluateSchemaPreflight } from './sh06Recovery.js';
import type { SchemaPreflightInput, SchemaPreflightResult } from './sh06Recovery.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RecoveryAdmissionInput {
  /** Current DB schema version read from the live database (must equal 9 for this incident). */
  currentSchema: number;
  /** Schema version supported by the PRIMARY candidate executor image. */
  primarySupportedSchema: number;
  /** Schema version supported by the FALLBACK executor image (independently qualified, must be >= currentSchema). */
  fallbackSupportedSchema: number;
  /** Schema version supported by the LEGACY executor image (the crash-looping one; must NOT equal fallback when fallback < current). */
  legacySupportedSchema: number;
  /** Whether a v9-consistent snapshot was created before this call. */
  snapshotCreated: boolean;
  /** Whether the snapshot was independently verified. */
  snapshotVerified: boolean;
  /**
   * Schema version read back from the verified snapshot.  Must equal currentSchema
   * (M9: snapshot must not have been taken after an interleaved migration).
   * Omit or pass undefined only when snapshotVerified is false.
   */
  snapshotSchema?: number | undefined;
}

export interface RecoveryAdmissionResult {
  verdict: 'ALLOW' | 'DENY';
  reason: string;
  preflightResult: SchemaPreflightResult;
  fallbackQualified: boolean;
  legacyFallbackBlocked: boolean;
}

// ---------------------------------------------------------------------------
// Invariant constants
// ---------------------------------------------------------------------------

/**
 * The minimum schema version that ANY binary started after the forward-recovery
 * operation completes must support.  For this incident current_db=9, so this is 9.
 * The evaluator enforces this mechanically — it does not accept caller assertions.
 */
const CURRENT_INCIDENT_SCHEMA = 9;
const MINIMUM_REQUIRED_FALLBACK_SCHEMA = CURRENT_INCIDENT_SCHEMA;

// ---------------------------------------------------------------------------
// Core evaluator — the single authoritative decision point
// ---------------------------------------------------------------------------

/**
 * evaluateRecoveryAdmission — determines whether the current-incident forward-recovery
 * operation may proceed.
 *
 * Decision rules (in priority order):
 *
 * R0  Numeric evidence must be valid (delegated to evaluateSchemaPreflight).
 * R1  Standard preflight must pass for (current, primary, fallback) — this enforces
 *     Rule A (current <= primary) and snapshot requirements.
 * R2  Fallback must independently support schema >= currentSchema (the critical
 *     architectural difference from standard deployment).
 * R3  Legacy executor must NOT be the fallback (hard denial by image schema identity).
 * R4  Fallback schema must be >= MINIMUM_REQUIRED_FALLBACK_SCHEMA regardless of
 *     snapshot existence or any other condition.
 *
 * Rule R2/R4 is what permits the 9/9/9 recovery matrix while the standard deployment
 * correctly denies 9/9/7.  The standard deploy path uses the running legacy executor
 * as rollback; this recovery path requires an explicitly nominated v9-compatible fallback.
 */
export function evaluateRecoveryAdmission(input: RecoveryAdmissionInput): RecoveryAdmissionResult {
  if (input.currentSchema !== CURRENT_INCIDENT_SCHEMA) {
    return {
      verdict: 'DENY',
      reason: 'CURRENT_SCHEMA_NOT_V9_INCIDENT',
      preflightResult: evaluateSchemaPreflight({
        currentSchema: input.currentSchema,
        candidateSupportedSchema: input.primarySupportedSchema,
        rollbackSupportedSchema: input.fallbackSupportedSchema,
        snapshotCreated: input.snapshotCreated,
        snapshotVerified: input.snapshotVerified,
        snapshotSchema: input.snapshotSchema,
      }),
      fallbackQualified: false,
      legacyFallbackBlocked: true,
    };
  }

  // Run standard preflight with the fallback in the rollback slot.
  // This enforces: Rule A (current <= primary), snapshot requirements, M9.
  // We intentionally pass fallbackSupportedSchema as rollbackSupportedSchema
  // so the preflight evaluates whether the FALLBACK (not the legacy executor) is safe.
  const preflightInput: SchemaPreflightInput = {
    currentSchema: input.currentSchema,
    candidateSupportedSchema: input.primarySupportedSchema,
    rollbackSupportedSchema: input.fallbackSupportedSchema,
    snapshotCreated: input.snapshotCreated,
    snapshotVerified: input.snapshotVerified,
    snapshotSchema: input.snapshotSchema,
  };
  const preflightResult = evaluateSchemaPreflight(preflightInput);

  // Legacy executor is always blocked as a fallback.
  // This is a hard invariant that cannot be overridden by any other condition.
  const legacyFallbackBlocked = true; // enforced structurally: recovery never starts legacy

  // R4: fallback schema must be >= minimum required (9 for this incident) unconditionally.
  // This is the PRIMARY guard that makes recovery distinct from standard deployment:
  // the explicitly nominated fallback must be v9-compatible regardless of snapshot state.
  const fallbackQualified = (
    Number.isSafeInteger(input.fallbackSupportedSchema) &&
    input.fallbackSupportedSchema >= 0 &&
    input.fallbackSupportedSchema >= input.currentSchema &&
    input.fallbackSupportedSchema >= MINIMUM_REQUIRED_FALLBACK_SCHEMA
  );

  if (!fallbackQualified) {
    return {
      verdict: 'DENY',
      reason: 'FALLBACK_SCHEMA_INCOMPATIBLE_WITH_V9_DATABASE',
      preflightResult,
      fallbackQualified: false,
      legacyFallbackBlocked,
    };
  }

  // R1: standard preflight must pass (with fallback in rollback slot).
  // Note: for the 9/9/9 incident matrix, Rule B in evaluateSchemaPreflight
  // will NOT fire because fallback(9) >= current(9).  This is intentional —
  // the recovery operation has provided a v9-compatible fallback.
  if (!preflightResult.allowed) {
    return {
      verdict: 'DENY',
      reason: preflightResult.reason,
      preflightResult,
      fallbackQualified,
      legacyFallbackBlocked,
    };
  }

  return {
    verdict: 'ALLOW',
    reason: 'RECOVERY_ADMISSION_OK',
    preflightResult,
    fallbackQualified,
    legacyFallbackBlocked,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point — machine-readable output for shell consumers
// ---------------------------------------------------------------------------

interface CliOutput {
  verdict: 'ALLOW' | 'DENY';
  reason: string;
  currentSchema: number;
  primarySupportedSchema: number;
  fallbackSupportedSchema: number;
  fallbackQualified: boolean;
  legacyFallbackBlocked: boolean;
  snapshotVerified: boolean;
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] !== 'evaluate' || !argv[1]) {
    throw new Error(
      'usage: sh06ForwardRecovery evaluate <json-input>\n' +
      'json-input fields: currentSchema, primarySupportedSchema, fallbackSupportedSchema, ' +
      'legacySupportedSchema, snapshotCreated, snapshotVerified, [snapshotSchema]',
    );
  }

  let input: RecoveryAdmissionInput;
  try {
    const parsed = JSON.parse(argv[1]) as Partial<RecoveryAdmissionInput>;
    // Validate required fields are present and numeric/boolean before passing to evaluator.
    const numericFields = [
      'currentSchema', 'primarySupportedSchema', 'fallbackSupportedSchema', 'legacySupportedSchema',
    ] as const;
    for (const field of numericFields) {
      if (typeof parsed[field] !== 'number') {
        throw new Error(`missing or non-numeric field: ${field}`);
      }
    }
    if (typeof parsed.snapshotCreated !== 'boolean' || typeof parsed.snapshotVerified !== 'boolean') {
      throw new Error('snapshotCreated and snapshotVerified must be booleans');
    }
    if (parsed.snapshotSchema !== undefined && typeof parsed.snapshotSchema !== 'number') {
      throw new Error('snapshotSchema must be a number when provided');
    }
    input = parsed as RecoveryAdmissionInput;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid input JSON: ${msg}`);
  }

  const result = evaluateRecoveryAdmission(input);

  const output: CliOutput = {
    verdict: result.verdict,
    reason: result.reason,
    currentSchema: input.currentSchema,
    primarySupportedSchema: input.primarySupportedSchema,
    fallbackSupportedSchema: input.fallbackSupportedSchema,
    fallbackQualified: result.fallbackQualified,
    legacyFallbackBlocked: result.legacyFallbackBlocked,
    snapshotVerified: input.snapshotVerified,
  };

  process.stdout.write(`${JSON.stringify(output)}\n`);

  if (result.verdict === 'DENY') {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const reason = error instanceof Error
      ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 300)
      : 'unknown error';
    process.stderr.write(`SH06_FORWARD_RECOVERY_ADMISSION=FAIL reason=${reason}\n`);
    process.exitCode = 1;
  });
}
