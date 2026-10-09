import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('undici', () => ({
  request: mocks.request,
}));

import { productAssessmentClient } from '../../src/gateway/productAssessmentClient.js';
import { registerSecurityAssessmentTools } from '../../src/gateway/securityAssessmentTools.js';
import { withPrincipal } from '../../src/gateway/context.js';

const MCP_TOKEN = 'm'.repeat(40);
const BRIDGE_TOKEN = 'b'.repeat(40);
const INTERNAL_TOKEN = 'i'.repeat(40);
const ASSESSMENT = `assessment_${'a'.repeat(24)}`;
const DISCOVERY = `disc_${'b'.repeat(24)}`;
const PLAN = `plan_${'c'.repeat(24)}`;
const REV = 'd'.repeat(40);
const DIGEST = 'e'.repeat(64);

function rawResponse(statusCode: number, value: string) {
  return {
    statusCode,
    body: {
      async *[Symbol.asyncIterator]() { yield Buffer.from(value); },
      destroy: vi.fn(),
    },
  };
}

function response(statusCode: number, value: unknown) {
  return rawResponse(statusCode, JSON.stringify(value));
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
    mocks.request.mockResolvedValueOnce(rawResponse(200, '{'));
    await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
      .rejects.toMatchObject({ code: 'INTERNAL' });

    mocks.request.mockResolvedValueOnce(rawResponse(200, 'x'.repeat(300 * 1024)));
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

  it('does not reflect a malicious upstream error code in a 503 BridgeError', async () => {
    const sentinel = 'SENTINEL_UNTRUSTED_UPSTREAM_CODE';
    mocks.request.mockResolvedValueOnce(response(503, { error: { code: sentinel, detail: sentinel } }));
    const error = await productAssessmentClient.status('principal-a', ASSESSMENT).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'DOCKER_UNAVAILABLE', httpStatus: 503 });
    expect(error.message).toBe('product assessment internal service is unavailable');
    expect(error.message).not.toContain(sentinel);
  });

  it('keeps the MCP error and audit detail free of upstream error text', async () => {
    const sentinel = 'SENTINEL_UNTRUSTED_UPSTREAM_CODE';
    mocks.request.mockResolvedValueOnce(response(503, { error: { code: sentinel, detail: sentinel } }));
    let statusHandler: ((args: { assessmentId: string }) => Promise<{ content: { text: string }[] }>) | undefined;
    registerSecurityAssessmentTools({
      registerTool(name: string, _config: unknown, handler: typeof statusHandler) {
        if (name === 'security_assessment_status') statusHandler = handler;
      },
    } as never);
    if (!statusHandler) throw new Error('missing assessment status tool');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = await withPrincipal({
        id: 'principal-a', name: 'test', keyHash: '',
        scopes: ['security:assessment:read'], targets: [], enabled: true,
      }, () => statusHandler!({ assessmentId: ASSESSMENT }));
      expect(result.content[0]?.text).toContain('product assessment internal service is unavailable');
      expect(result.content[0]?.text).not.toContain(sentinel);
      const auditLine = String(output.mock.calls.at(-1)?.[0]);
      expect(JSON.parse(auditLine).detail).toBe('product assessment internal service is unavailable');
      expect(auditLine).not.toContain(sentinel);
    } finally {
      output.mockRestore();
    }
  });

  it('stops reading and disposes an oversized streamed response immediately', async () => {
    const read = vi.fn();
    const destroy = vi.fn();
    mocks.request.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        async *[Symbol.asyncIterator]() {
          for (const chunk of [Buffer.alloc(128 * 1024), Buffer.alloc(128 * 1024), Buffer.of(1), Buffer.of(2)]) {
            read();
            yield chunk;
          }
        },
        destroy,
      },
    });
    await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
      .rejects.toMatchObject({ code: 'INTERNAL', message: 'product assessment internal response exceeded bound' });
    expect(read).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('accepts exactly 256 KiB and rejects one byte more', async () => {
    const valid = JSON.stringify({ data: summary() });
    const boundary = valid.padEnd(256 * 1024, ' ');
    mocks.request.mockResolvedValueOnce(rawResponse(200, boundary));
    await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
      .resolves.toMatchObject({ id: ASSESSMENT });
    mocks.request.mockResolvedValueOnce(rawResponse(200, `${boundary} `));
    await expect(productAssessmentClient.status('principal-a', ASSESSMENT))
      .rejects.toMatchObject({ code: 'INTERNAL', message: 'product assessment internal response exceeded bound' });
  });

  it('turns a malicious response stream failure into a fixed bounded BridgeError', async () => {
    const sentinel = 'SENTINEL_MALICIOUS_STREAM_FAILURE';
    const destroy = vi.fn();
    mocks.request.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        async *[Symbol.asyncIterator]() { throw new Error(sentinel); },
        destroy,
      },
    });
    const error = await productAssessmentClient.status('principal-a', ASSESSMENT).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'DOCKER_UNAVAILABLE', httpStatus: 503 });
    expect(error.message).toBe('product assessment internal response could not be read');
    expect(error.message).not.toContain(sentinel);
    expect(destroy).toHaveBeenCalledOnce();
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
