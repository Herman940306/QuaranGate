import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('undici', () => ({
  request: mocks.request,
}));

import { productAssessmentClient } from '../../src/gateway/productAssessmentClient.js';

const MCP_TOKEN = 'm'.repeat(40);
const BRIDGE_TOKEN = 'b'.repeat(40);
const INTERNAL_TOKEN = 'i'.repeat(40);
const ASSESSMENT = `assessment_${'a'.repeat(24)}`;
const DISCOVERY = `disc_${'b'.repeat(24)}`;
const PLAN = `plan_${'c'.repeat(24)}`;
const REV = 'd'.repeat(40);
const DIGEST = 'e'.repeat(64);

function response(statusCode: number, value: unknown) {
  return {
    statusCode,
    body: { text: async () => JSON.stringify(value) },
  };
}

function binding() {
  return {
    assessmentId: ASSESSMENT,
    assessmentVersion: 0,
    correlationId: 'corr-client',
    principalRef: 'principal-a',
    principalMappingVersion: 1,
    discoveryId: DISCOVERY,
    discoveryDigest: DIGEST,
    planId: PLAN,
    planDigest: DIGEST,
    projectId: 'project-a',
    expectedSourceRevision: REV,
    assessmentIntent: 'source',
    requestedCapabilityClasses: ['STATIC_SOURCE'],
    networkClass: 'NONE',
    credentialClass: 'NONE',
  };
}

function summary() {
  return {
    id: ASSESSMENT,
    state: 'PLANNED',
    version: 0,
    discoveryId: DISCOVERY,
    planId: PLAN,
    binding: { projectId: 'project-a', sourceRevision: REV, assessmentIntent: 'source' },
    requestedAt: '2026-09-27T21:00:00.000Z',
    updatedAt: '2026-09-27T21:00:00.000Z',
    correlationId: 'corr-client',
  };
}

describe('BE9.2 product assessment MCP client bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.QG_PRODUCT_INTERNAL_URL = 'http://product.internal';
    process.env.PRODUCT_ASSESSMENT_MCP_TOKEN = MCP_TOKEN;
    process.env.PRODUCT_ASSESSMENT_BRIDGE_TOKEN = BRIDGE_TOKEN;
    process.env.INTERNAL_TOKEN = INTERNAL_TOKEN;
  });

  afterEach(() => {
    delete process.env.QG_PRODUCT_INTERNAL_URL;
    delete process.env.PRODUCT_ASSESSMENT_MCP_TOKEN;
    delete process.env.PRODUCT_ASSESSMENT_BRIDGE_TOKEN;
    delete process.env.INTERNAL_TOKEN;
  });

  it('uses only a configured origin and the dedicated MCP service credential', async () => {
    mocks.request.mockResolvedValueOnce(response(200, { data: binding() }));
    await expect(productAssessmentClient.startIntent('principal-a', DISCOVERY, 'corr-client'))
      .resolves.toMatchObject({ assessmentId: ASSESSMENT });
    expect(mocks.request).toHaveBeenCalledWith(
      'http://product.internal/internal/security/assessment/mcp',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-product-assessment-mcp-token': MCP_TOKEN,
        }),
      }),
    );
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({
      action: 'start',
      principalRef: 'principal-a',
      discoveryId: DISCOVERY,
      correlationId: 'corr-client',
    });
  });

  it('rejects internal URL paths, query strings, userinfo, and unsupported schemes before network I/O', async () => {
    for (const value of [
      'http://product.internal/path',
      'http://product.internal?x=1',
      'http://user:pass@product.internal',
      'file:///tmp/product.sock',
    ]) {
      vi.clearAllMocks();
      process.env.QG_PRODUCT_INTERNAL_URL = value;
      await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(mocks.request).not.toHaveBeenCalled();
    }
  });

  it('rejects token reuse with broader internal assessment credentials before network I/O', async () => {
    for (const value of [BRIDGE_TOKEN, INTERNAL_TOKEN]) {
      vi.clearAllMocks();
      process.env.QG_PRODUCT_INTERNAL_URL = 'http://product.internal';
      process.env.PRODUCT_ASSESSMENT_MCP_TOKEN = value;
      await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(mocks.request).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed, oversized, or bad-envelope product responses', async () => {
    mocks.request.mockResolvedValueOnce({ statusCode: 200, body: { text: async () => '{' } });
    await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
      .rejects.toMatchObject({ code: 'INTERNAL' });

    mocks.request.mockResolvedValueOnce({ statusCode: 200, body: { text: async () => 'x'.repeat(300 * 1024) } });
    await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
      .rejects.toMatchObject({ code: 'INTERNAL' });

    mocks.request.mockResolvedValueOnce(response(200, { ok: true }));
    await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
      .rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('maps bounded product service errors without leaking product internals', async () => {
    for (const [statusCode, code] of [
      [400, 'MALFORMED_REQUEST'],
      [403, 'FORBIDDEN_PROJECT'],
      [404, 'PRECONDITION_FAILED'],
      [409, 'CONCURRENCY_LIMIT'],
      [503, 'DOCKER_UNAVAILABLE'],
    ] as const) {
      mocks.request.mockResolvedValueOnce(response(statusCode, { error: { code: 'PRODUCT_DETAIL' } }));
      await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
        .rejects.toMatchObject({ code });
    }
  });

  it('returns summary/evidence data through the bounded internal route only', async () => {
    mocks.request.mockResolvedValueOnce(response(200, { data: summary() }));
    await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
      .resolves.toMatchObject({ id: ASSESSMENT, state: 'PLANNED' });

    mocks.request.mockResolvedValueOnce(response(200, { data: { admissions: [], evidence: [] } }));
    await expect(productAssessmentClient.evidence('principal-a', ASSESSMENT))
      .resolves.toEqual({ admissions: [], evidence: [] });
  });
});
