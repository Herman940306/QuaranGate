/**
 * Backend-neutral session continuity policy — Phase A8.
 *
 * Pure binding/advisory functions for the session-policy decision. Production
 * dispatch admission is owned by AgentJobStore.insertWithSessionReservation(),
 * which performs lookup + ACTIVE->RESERVED CAS + job INSERT atomically.
 * No Docker, no network, no credentials. Operates only on the session store and
 * the trusted dispatch context.
 *
 * Security invariants:
 *   - `resolveSessionForResume()` performs the full 4-tuple binding check. A
 *     mismatch on ANY field yields SESSION_NOT_RESUMABLE regardless of which
 *     field differed. No partial-match behaviour.
 *   - Authorization is NOT checked here. This module assumes the caller
 *     (AgentJobEngine.dispatch) has already re-validated all grants against
 *     the trusted configuration BEFORE calling these functions.
 *   - `providerSessionId` is never passed to or returned by these functions.
 *     Only the AgentJobStore/AgentSessionStore internal callers touch it.
 *   - Session state is never used as a permission source. The session row
 *     carries identity binding only.
 *   - ODR-1: FAIL CLOSED — `resume` with no eligible session → throws
 *     SESSION_NOT_RESUMABLE. No silent fallback to `new`.
 */
import { BridgeError } from '../../shared/errors.js';
import type { AgentSessionStore, AgentSessionRow } from './sessionStore.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal binding context from a trusted dispatch request. */
export interface SessionBindingContext {
  principalId: string;
  project: string;
  backend: string;
  profile: string;
}

export type ResolvedSessionPolicy =
  | { kind: 'new' }
  | { kind: 'resume'; sessionId: string };

// ---------------------------------------------------------------------------
// Pure binding check
// ---------------------------------------------------------------------------

/**
 * Verify that a stored session matches the current authorized dispatch context.
 * Returns true only if ALL four binding fields match exactly. This check is
 * the cross-principal/cross-project/cross-backend/cross-profile isolation gate.
 *
 * Exported for direct unit testing.
 */
export function sessionBindingMatches(
  session: AgentSessionRow,
  ctx: SessionBindingContext,
): boolean {
  return (
    session.principalId === ctx.principalId &&
    session.project     === ctx.project     &&
    session.backend     === ctx.backend     &&
    session.profile     === ctx.profile
  );
}

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the session to use for a dispatch request.
 *
 * `sessionPolicy = 'new'`:
 *   Always returns `{ kind: 'new' }`. Does NOT consume or alter any existing
 *   session row — a caller using `new` may still have an active session from a
 *   prior dispatch; it is left alone.
 *
 * `sessionPolicy = 'resume'` (or undefined, treated as 'new'):
 *   Looks up the most-recent ACTIVE session for the exact binding context.
 *   - If found and binding matches: returns `{ kind: 'resume', sessionId }`.
 *   - If not found: throws SESSION_NOT_RESUMABLE (ODR-1: fail closed).
 *   - If found but binding does NOT match: cannot happen (findActiveSession
 *     queries by the binding tuple), but guarded defensively.
 *
 * Authorization has already been fully re-validated by `AgentJobEngine.dispatch()`
 * before this function is called. This function performs identity binding
 * only — it does NOT re-check grants.
 */
export function resolveSessionPolicy(
  policy: 'new' | 'resume' | undefined,
  ctx: SessionBindingContext,
  store: AgentSessionStore,
): ResolvedSessionPolicy {
  // Default policy is 'new' — no implicit continuation.
  if (!policy || policy === 'new') {
    return { kind: 'new' };
  }

  // policy === 'resume'
  const existing = store.findActiveSession(
    ctx.principalId, ctx.project, ctx.backend, ctx.profile,
  );

  if (!existing) {
    throw new BridgeError(
      'SESSION_NOT_RESUMABLE',
      `no active session found for the current authorized context ` +
      `(principal=${ctx.principalId}, project=${ctx.project}, ` +
      `backend=${ctx.backend}, profile=${ctx.profile}); ` +
      `use sessionPolicy "new" to start a fresh session`,
      404,
    );
  }

  // Defensive binding re-check: findActiveSession queries by the full tuple,
  // so this should always pass. If it ever fails (e.g. a future query change),
  // fail closed rather than silently allowing cross-context resume.
  if (!sessionBindingMatches(existing, ctx)) {
    throw new BridgeError(
      'SESSION_NOT_RESUMABLE',
      `session ${existing.sessionId} binding does not match current context ` +
      `(internal consistency error); failing closed`,
      500,
    );
  }

  return { kind: 'resume', sessionId: existing.sessionId };
}

/**
 * Mark a session as consumed by a specific job. Must be called inside the same
 * transaction that records the job's completion result, so session consumption
 * and job finalization are atomic.
 *
 * Returns true if the session was successfully consumed.
 * Returns false unless the exact job owns the RESERVED session. Production
 * completion treats false as a hard failure inside the atomic transaction.
 */
export function consumeSessionForJob(
  sessionId: string,
  jobId: string,
  store: AgentSessionStore,
): boolean {
  return store.consumeReservedSession(sessionId, jobId);
}
