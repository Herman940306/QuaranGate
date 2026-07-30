/** Typed, fail-closed error model shared by gateway and executor. */

export type BridgeErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIAL'
  | 'CLIENT_DISABLED'
  | 'FORBIDDEN_SCOPE'
  | 'FORBIDDEN_TARGET'
  | 'UNKNOWN_TARGET'
  | 'AMBIGUOUS_TARGET'
  | 'TARGET_OFFLINE'
  | 'TARGET_UNSUPPORTED'
  | 'PATH_VIOLATION'
  | 'FILE_NOT_FOUND'
  | 'PATCH_FAILED'
  | 'COMMAND_TIMEOUT'
  | 'COMMAND_FAILED'
  | 'OUTPUT_TRUNCATED'
  | 'CONCURRENCY_LIMIT'
  | 'RATE_LIMITED'
  | 'DOCKER_UNAVAILABLE'
  | 'MALFORMED_REQUEST'
  | 'INVALID_JOB_TRANSITION'
  | 'AGENTS_UNAVAILABLE'
  | 'UNKNOWN_JOB'
  | 'UNKNOWN_PROJECT'
  | 'FORBIDDEN_PROJECT'
  | 'FORBIDDEN_BACKEND'
  | 'FORBIDDEN_PROFILE'
  | 'FORBIDDEN_JOB'
  | 'FORBIDDEN_POLICY'
  | 'PRECONDITION_FAILED'
  | 'SANDBOX_FAILED'
  | 'INVALID_ATTEMPT_TRANSITION'
  | 'PROJECT_QUARANTINED'
  | 'GUARDED_PATH_DENIED'
  | 'APPLY_ATTEMPT_ACTIVE'
  | 'APPLY_ATTEMPT_UNCERTAIN'
  | 'DUPLICATE_ATTEMPT_ID'
  | 'BEFORE_CAPTURE_PATH_ESCAPE'
  | 'BEFORE_CAPTURE_UNSAFE_PATH'
  | 'BEFORE_CAPTURE_UNSUPPORTED_ENTRY'
  | 'BEFORE_CAPTURE_LIMIT'
  | 'BEFORE_CAPTURE_IO'
  | 'POST_CAPTURE_QUIESCENCE_FAILED'
  | 'POST_CAPTURE_LIMIT'
  | 'POST_CAPTURE_IO'
  | 'CANONICAL_VALIDATION_FAILED'
  | 'ARTIFACT_B2_INTEGRITY_FAILED'
  | 'ARTIFACT_BLOB_INVALID'
  | 'ARTIFACT_BUDGET_EXCEEDED'
  | 'ARTIFACT_STORAGE_INTEGRITY_FAILED'
  | 'ARTIFACT_NOT_AVAILABLE'
  | 'ARTIFACT_ALREADY_FINALIZED'
  | 'ARTIFACT_PUBLICATION_FAILED'
  | 'ARTIFACT_REQUIRED'
  | 'BASE_CERTIFICATION_FAILED'
  | 'INTERNAL';

export class BridgeError extends Error {
  constructor(
    public readonly code: BridgeErrorCode,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'BridgeError';
  }

  toJSON() {
    return { error: this.code, message: this.message };
  }
}

export function asBridgeError(e: unknown): BridgeError {
  if (e instanceof BridgeError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new BridgeError('INTERNAL', msg, 500);
}
