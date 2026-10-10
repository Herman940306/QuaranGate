import type express from 'express';
import { BridgeError } from '../../shared/errors.js';
import type { SecurityAssessmentOperationalPreflightRequest } from '../../shared/securityAssessment.js';
import type { SecurityAssessmentOperationalService } from './service.js';

type HandlerWrapper = (
  fn: (req: express.Request, res: express.Response) => Promise<unknown>,
) => express.RequestHandler;

const PREFLIGHT_KEYS = new Set([
  'assessmentId',
  'projectId',
  'targetId',
  'expectedSourceRevision',
  'requireRunningTarget',
  'requestedCapabilityClasses',
]);

function closedObject(value: unknown, allowed: ReadonlySet<string>, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError('MALFORMED_REQUEST', `${name} body must be an object`, 400);
  }
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new BridgeError('MALFORMED_REQUEST', `${name} body has unsupported fields`, 400);
  }
  return object;
}

function preflightRequest(value: unknown): SecurityAssessmentOperationalPreflightRequest {
  const body = closedObject(value, PREFLIGHT_KEYS, 'security assessment preflight');
  return {
    assessmentId: String(body.assessmentId ?? ''),
    projectId: String(body.projectId ?? ''),
    ...(body.targetId === undefined ? {} : { targetId: String(body.targetId) }),
    expectedSourceRevision: String(body.expectedSourceRevision ?? ''),
    requireRunningTarget: body.requireRunningTarget === true,
    requestedCapabilityClasses: Array.isArray(body.requestedCapabilityClasses)
      ? body.requestedCapabilityClasses.map(String)
      : [],
  };
}

export function registerSecurityAssessmentRoutes(
  app: express.Express,
  handle: HandlerWrapper,
  getService: () => SecurityAssessmentOperationalService | null,
): void {
  const requireService = (): SecurityAssessmentOperationalService => {
    const service = getService();
    if (!service) {
      throw new BridgeError('PRECONDITION_FAILED', 'security assessment operational service is unavailable', 503);
    }
    return service;
  };

  app.post('/security-assessment/replay/claim', handle(async (req) => {
    const body = closedObject(
      req.body,
      new Set(['bridgeRequestId', 'nonce', 'assessmentId', 'assessmentVersion', 'expiresAt']),
      'security assessment replay claim',
    );
    if (!Number.isSafeInteger(body.assessmentVersion)) {
      throw new BridgeError('MALFORMED_REQUEST', 'security assessment replay version must be an integer', 400);
    }
    return {
      claimed: requireService().claimReplay({
        bridgeRequestId: String(body.bridgeRequestId ?? ''),
        nonce: String(body.nonce ?? ''),
        assessmentId: String(body.assessmentId ?? ''),
        assessmentVersion: body.assessmentVersion as number,
        expiresAt: String(body.expiresAt ?? ''),
      }),
    };
  }));

  app.post('/security-assessment/preflight', handle(async (req) => {
    return requireService().preflight(preflightRequest(req.body));
  }));

  app.post('/security-assessment/prepare', handle(async (req) => {
    return requireService().prepare(preflightRequest(req.body));
  }));

  app.post('/security-assessment/revalidate', handle(async (req) => {
    const body = closedObject(req.body, new Set(['assessmentId']), 'security assessment revalidate');
    return requireService().revalidateBeforeRun(String(body.assessmentId ?? ''));
  }));

  app.post('/security-assessment/cleanup', handle(async (req) => {
    const body = closedObject(
      req.body,
      new Set(['assessmentId', 'expectedExecutionId', 'uncertain']),
      'security assessment cleanup',
    );
    if (typeof body.expectedExecutionId !== 'string'
      || !/^job_[0-9a-f]{32}$/.test(body.expectedExecutionId)) {
      throw new BridgeError('MALFORMED_REQUEST', 'security assessment cleanup requires exact allocation identity', 400);
    }
    if (body.uncertain !== undefined && typeof body.uncertain !== 'boolean') {
      throw new BridgeError('MALFORMED_REQUEST', 'security assessment cleanup uncertain must be boolean', 400);
    }
    await requireService().cleanup(
      String(body.assessmentId ?? ''),
      body.expectedExecutionId,
      body.uncertain === true,
    );
    return { ok: true };
  }));
}
