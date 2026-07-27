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
