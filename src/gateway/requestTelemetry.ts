import { randomUUID } from 'node:crypto';
import type express from 'express';

const REQUEST_ID_LOCAL = 'quarangateRequestId';
const OUTCOME_LOCAL = 'quarangateRequestOutcome';
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();
const connectionIds = new WeakMap<object, string>();

const OBSERVED_PATHS = new Map<string, string>([
  ['/mcp', '/mcp'],
  ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource'],
  ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource/mcp'],
  ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server'],
  ['/oauth/register', '/oauth/register'],
  ['/oauth/authorize', '/oauth/authorize'],
  ['/oauth/token', '/oauth/token'],
]);

export interface RequestTelemetryEvent {
  ts: string;
  event: 'http_request_start' | 'http_request_complete' | 'http_request_aborted';
  requestId: string;
  connectionId: string;
  method: string;
  path: string;
  httpVersion: string;
  serverPid: number;
  processStartedAt: string;
  buildRevision: string;
  status?: number;
  durationMs?: number;
  outcome?: RequestTelemetryOutcome;
}

export type RequestTelemetryEmitter = (event: RequestTelemetryEvent) => void;
export type RequestTelemetryOutcome =
  | 'oauth_invalid_redirect_uri'
  | 'oauth_invalid_client_metadata'
  | 'oauth_registration_capacity'
  | 'oauth_authorize_invalid_request'
  | 'oauth_authorize_invalid_api_key'
  | 'oauth_code_missing_or_expired'
  | 'oauth_code_binding_or_pkce_mismatch'
  | 'oauth_refresh_token_missing'
  | 'oauth_refresh_token_wrong_type'
  | 'oauth_refresh_token_expired'
  | 'oauth_refresh_client_mismatch'
  | 'oauth_refresh_resource_mismatch'
  | 'oauth_unsupported_grant_type';

function defaultEmit(event: RequestTelemetryEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function connectionId(req: express.Request): string {
  const socket = req.socket;
  let id = connectionIds.get(socket);
  if (!id) {
    id = randomUUID();
    connectionIds.set(socket, id);
  }
  return id;
}

export function requestTelemetryId(res: express.Response): string | undefined {
  const value: unknown = res.locals[REQUEST_ID_LOCAL];
  return typeof value === 'string' ? value : undefined;
}

export function setRequestTelemetryOutcome(res: express.Response, outcome: RequestTelemetryOutcome): void {
  res.locals[OUTCOME_LOCAL] = outcome;
}

/**
 * Metadata-only ingress telemetry for the public MCP and OAuth boundaries.
 *
 * Deliberately excluded: headers, query strings, cookies, bodies, tool
 * arguments, response bodies, raw peer addresses and caller-provided request
 * IDs. Unknown paths are not logged, so an attacker cannot place arbitrary
 * text into this audit stream through a URL.
 */
export function mountRequestTelemetry(
  app: express.Express,
  emit: RequestTelemetryEmitter = defaultEmit,
): void {
  app.use((req, res, next) => {
    const safePath = OBSERVED_PATHS.get(req.path);
    if (!safePath) {
      next();
      return;
    }

    const requestId = randomUUID();
    const connId = connectionId(req);
    const startedAtNs = process.hrtime.bigint();
    const common = {
      requestId,
      connectionId: connId,
      method: req.method,
      path: safePath,
      httpVersion: req.httpVersion,
      serverPid: process.pid,
      processStartedAt: PROCESS_STARTED_AT,
      buildRevision: process.env.QUARANGATE_BUILD_REVISION ?? 'unknown',
    };
    res.locals[REQUEST_ID_LOCAL] = requestId;
    res.setHeader('X-QuaranGate-Request-Id', requestId);
    emit({ ts: new Date().toISOString(), event: 'http_request_start', ...common });

    let terminalEmitted = false;
    const emitTerminal = (event: 'http_request_complete' | 'http_request_aborted'): void => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      emit({
        ts: new Date().toISOString(),
        event,
        ...common,
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - startedAtNs) / 1_000_000),
        ...(typeof res.locals[OUTCOME_LOCAL] === 'string'
          ? { outcome: res.locals[OUTCOME_LOCAL] as RequestTelemetryOutcome }
          : {}),
      });
    };

    res.once('finish', () => emitTerminal('http_request_complete'));
    res.once('close', () => emitTerminal(res.writableFinished ? 'http_request_complete' : 'http_request_aborted'));
    next();
  });
}
