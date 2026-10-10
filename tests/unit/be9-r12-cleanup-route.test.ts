import { describe, expect, it, vi } from 'vitest';
import { registerSecurityAssessmentRoutes } from '../../src/executor/securityAssessment/routes.js';

const assessmentId = `assessment_${'a'.repeat(24)}`;
const executionId = `job_${'b'.repeat(32)}`;

function harness() {
  const handlers = new Map<string, (req: { body: unknown }) => Promise<unknown>>();
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const app = {
    post: (path: string, fn: (req: { body: unknown }) => Promise<unknown>) => {
      handlers.set(path, fn);
    },
  };
  registerSecurityAssessmentRoutes(
    app as never, ((fn: (req: { body: unknown }) => Promise<unknown>) => fn) as never,
    () => ({ cleanup }) as never,
  );
  return { handler: handlers.get('/security-assessment/cleanup')!, cleanup };
}

describe('BE9 R12 trusted internal cleanup route generation boundary', () => {
  it('refuses absent or malformed allocation IDs before service invocation', async () => {
    const { handler, cleanup } = harness();
    for (const body of [
      { assessmentId }, { assessmentId, expectedExecutionId: null },
      { assessmentId, expectedExecutionId: 'job_invalid' },
      { assessmentId, expectedExecutionId: executionId, unknownField: true },
    ]) {
      await expect(handler({ body })).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    }
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('passes the exact caller-issued generation without resolving current server state', async () => {
    const { handler, cleanup } = harness();
    expect(await handler({ body: { assessmentId, expectedExecutionId: executionId, uncertain: true } }))
      .toEqual({ ok: true });
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(assessmentId, executionId, true);
  });
});
