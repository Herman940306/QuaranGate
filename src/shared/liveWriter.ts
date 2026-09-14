/** P7 B8 shared live-worktree writer arbitration vocabulary. */
import { BridgeError } from './errors.js';

export const LIVE_WRITER_LEASE_ID_PATTERN = /^wrl_[0-9a-f]{32}$/;
export const LIVE_WRITER_OWNER_KINDS = ['agent_apply', 'ide'] as const;
export type LiveWriterOwnerKind = (typeof LIVE_WRITER_OWNER_KINDS)[number];
export const LIVE_WRITER_LEASE_STATES = ['ACTIVE', 'RELEASED', 'UNCERTAIN'] as const;
export type LiveWriterLeaseState = (typeof LIVE_WRITER_LEASE_STATES)[number];
export const LIVE_WRITER_LOGICAL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const LIVE_WRITER_PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function assertLiveWriterLogicalId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !LIVE_WRITER_LOGICAL_ID_PATTERN.test(value)) {
    throw new BridgeError('MALFORMED_REQUEST', `${field} is not a valid live-writer logical id`, 400);
  }
}
export function assertLiveWriterPrincipalId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !LIVE_WRITER_PRINCIPAL_ID_PATTERN.test(value)) {
    throw new BridgeError('MALFORMED_REQUEST', 'principalId is not a valid live-writer principal id', 400);
  }
}
export function assertLiveWriterLeaseId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !LIVE_WRITER_LEASE_ID_PATTERN.test(value)) {
    throw new BridgeError('MALFORMED_REQUEST', 'writerLeaseId is invalid', 400);
  }
}
export function assertLiveWriterOwner(kind: LiveWriterOwnerKind, ownerId: unknown): asserts ownerId is string {
  const ok = kind === 'agent_apply'
    ? typeof ownerId === 'string' && /^att_[0-9a-f]{32}$/.test(ownerId)
    : typeof ownerId === 'string' && /^ideo_[0-9a-f]{32}$/.test(ownerId);
  if (!ok) throw new BridgeError('MALFORMED_REQUEST', `invalid ${kind} live-writer owner id`, 400);
}
