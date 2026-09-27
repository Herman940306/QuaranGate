import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BridgeError, asBridgeError } from '../shared/errors.js';
import { executor } from './executorClient.js';
import { audit, newReqId } from './audit.js';
import { currentPrincipal } from './context.js';
import { principalHasScope, type Principal } from './config.js';
import { SecurityAssessmentAdmissionService } from './securityAssessmentAdmission.js';
import { productAssessmentClient, type SecurityAssessmentSummaryWire } from './productAssessmentClient.js';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const CANCEL = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: object): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: { ...data },
  };
}

function assessmentGuarded(
  tool: string,
  mode: 'read' | 'write',
  fn: (args: any, principal: Principal, correlationId: string) => Promise<object>,
) {
  return async (args: any): Promise<ToolResult> => {
    const correlationId = newReqId();
    const started = Date.now();
    const principal = currentPrincipal();
    try {
      if (!principal) throw new BridgeError('UNAUTHENTICATED', 'no principal in context', 401);
      const scope = mode === 'read' ? 'security:assessment:read' : 'security:assessment:write';
      if (!principalHasScope(principal, scope)) {
        throw new BridgeError('FORBIDDEN_SCOPE', `missing scope ${scope}`, 403);
      }
      const result = await fn(args, principal, correlationId);
      audit({
        reqId: correlationId,
        principal: principal.id,
        tool,
        target: null,
        decision: 'allow',
        durationMs: Date.now() - started,
      });
      return ok(result);
    } catch (error) {
      const be = asBridgeError(error);
      audit({
        reqId: correlationId,
        principal: principal?.id ?? null,
        tool,
        target: null,
        decision: 'deny',
        code: be.code,
        durationMs: Date.now() - started,
        detail: be.message,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: be.code, message: be.message }),
        }],
        isError: true,
      };
    }
  };
}

function summary(record: SecurityAssessmentSummaryWire) {
  if (!/^assessment_[0-9a-f]{24}$/.test(record.id)
    || !Number.isSafeInteger(record.version)
    || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(record.binding?.projectId ?? '')
    || !/^[0-9a-f]{40}$/.test(record.binding?.sourceRevision ?? '')) {
    throw new BridgeError('INTERNAL', 'product assessment summary failed runtime validation', 503);
  }
  return {
    assessmentId: record.id,
    state: record.state,
    version: record.version,
    discoveryId: record.discoveryId,
    planId: record.planId,
    projectId: record.binding.projectId,
    ...(record.binding.targetId ? { targetId: record.binding.targetId } : {}),
    sourceRevision: record.binding.sourceRevision,
    requestedAt: record.requestedAt,
    updatedAt: record.updatedAt,
  };
}

const SUMMARY_SCHEMA = {
  assessmentId: z.string().regex(/^assessment_[0-9a-f]{24}$/),
  state: z.string(),
  version: z.number().int().nonnegative(),
  discoveryId: z.string().regex(/^disc_[0-9a-f]{24}$/),
  planId: z.string().regex(/^plan_[0-9a-f]{24}$/),
  projectId: z.string(),
  targetId: z.string().optional(),
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
  requestedAt: z.string(),
  updatedAt: z.string(),
} as const;

export function registerSecurityAssessmentTools(server: McpServer): void {
  const admission = new SecurityAssessmentAdmissionService({
    principalById: () => undefined,
    preflight: (request) => executor.securityAssessmentPreflight(request),
  });

  server.registerTool('security_assessment_start', {
    title: 'Start governed security assessment',
    description: 'Create a BE9 assessment from an existing server-owned discovery. The discovery determines tenant/project/source identity; callers cannot supply workspace, host path, scanner, image, argv, network or Docker options. BE10 scanner capability remains unavailable until separately accepted.',
    inputSchema: z.strictObject({
      discoveryId: z.string().regex(/^disc_[0-9a-f]{24}$/),
    }),
    outputSchema: z.strictObject(SUMMARY_SCHEMA),
    annotations: WRITE,
  }, assessmentGuarded('security_assessment_start', 'write', async (args, principal, correlationId) => {
    const binding = await productAssessmentClient.startIntent(
      principal.id,
      args.discoveryId,
      correlationId,
    );
    if (binding.principalRef !== principal.id) {
      throw new BridgeError('FORBIDDEN_PROJECT', 'assessment discovery Principal binding mismatch', 403);
    }
    const receipt = await admission.admitResolvedPrincipal(principal, binding);
    const record = await productAssessmentClient.applyAdmission(principal.id, receipt);
    return summary(record);
  }));

  server.registerTool('security_assessment_status', {
    title: 'Get security assessment status',
    description: 'Read lifecycle status for one assessment already bound to the authenticated Principal and its durable tenant/project identity.',
    inputSchema: z.strictObject({
      assessmentId: z.string().regex(/^assessment_[0-9a-f]{24}$/),
    }),
    outputSchema: z.strictObject(SUMMARY_SCHEMA),
    annotations: READ,
  }, assessmentGuarded('security_assessment_status', 'read', async (args, principal) => {
    return summary(await productAssessmentClient.status(principal.id, args.assessmentId));
  }));

  server.registerTool('security_assessment_cancel', {
    title: 'Cancel security assessment',
    description: 'Durably request cancellation of an assessment bound to the authenticated Principal. This does not expose terminal, agent, Docker or raw process authority.',
    inputSchema: z.strictObject({
      assessmentId: z.string().regex(/^assessment_[0-9a-f]{24}$/),
    }),
    outputSchema: z.strictObject(SUMMARY_SCHEMA),
    annotations: CANCEL,
  }, assessmentGuarded('security_assessment_cancel', 'write', async (args, principal) => {
    return summary(await productAssessmentClient.cancel(principal.id, args.assessmentId));
  }));

  server.registerTool('security_assessment_evidence', {
    title: 'Get security assessment evidence index',
    description: 'Return bounded immutable admission/evidence metadata for one assessment. Raw large artifacts, credentials and source bytes are not returned.',
    inputSchema: z.strictObject({
      assessmentId: z.string().regex(/^assessment_[0-9a-f]{24}$/),
    }),
    outputSchema: z.strictObject({
      assessmentId: z.string().regex(/^assessment_[0-9a-f]{24}$/),
      admissionReceipts: z.array(z.strictObject({
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        decision: z.string(),
        decisionCode: z.string(),
        decisionAt: z.string(),
      })),
      evidence: z.array(z.strictObject({
        type: z.string(),
        producerClass: z.string(),
        sha256Hex: z.string().regex(/^[0-9a-f]{64}$/),
        sizeBytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
        finalized: z.boolean(),
        createdAt: z.string(),
        finalizedAt: z.string().optional(),
      })),
      scannerExecutionAvailable: z.literal(false),
    }),
    annotations: READ,
  }, assessmentGuarded('security_assessment_evidence', 'read', async (args, principal) => {
    const index = await productAssessmentClient.evidence(principal.id, args.assessmentId);
    return {
      assessmentId: args.assessmentId,
      admissionReceipts: index.admissions.map((receipt) => ({
        digest: receipt.admissionReceiptDigest,
        decision: receipt.decision,
        decisionCode: receipt.decisionCode,
        decisionAt: receipt.decisionAt,
      })),
      evidence: index.evidence,
      scannerExecutionAvailable: false as const,
    };
  }));
}
