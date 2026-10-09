import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request, routes } = vi.hoisted(() => ({
  request: vi.fn(), routes: new Map<string, (req: unknown, res: unknown) => Promise<void>>(),
}));
vi.mock('undici', () => ({ Pool: class { request = request; } }));
vi.mock('express', () => ({ default: Object.assign(() => ({
  use: vi.fn(), get: vi.fn(), listen: vi.fn(),
  post: (path: string, handler: (req: unknown, res: unknown) => Promise<void>) => routes.set(path, handler),
}), { json: () => vi.fn() }) }));

const assessment = `assessment_${'a'.repeat(24)}`;
const job = `job_${'b'.repeat(32)}`;
const id = 'c'.repeat(64);
const labels = (resource: string) => ({
  'io.quarangate.managed': 'true', 'io.quarangate.resource': resource,
  'io.quarangate.assessment': assessment, 'io.quarangate.job': job,
});
const exact = (resource: string) => ({ label: Object.entries(labels(resource)).map(([k, v]) => `${k}=${v}`) });
const dockerReply = (statusCode: number, value: unknown) => ({
  statusCode, headers: {}, body: { arrayBuffer: async () => Buffer.from(JSON.stringify(value)) },
});

async function operation(op: string, filters: unknown) {
  const handler = routes.get('/v1/operation')!;
  let status = 200;
  let body: unknown;
  await handler({ body: { op, payload: { filters, all: true } } }, {
    status(value: number) { status = value; return this; },
    json(value: unknown) { body = value; return this; },
  });
  return { status, body };
}

describe('BE9 exact Docker inventory', () => {
  beforeEach(async () => {
    vi.resetModules(); request.mockReset(); routes.clear();
    await import('../../src/docker-authority/server.js');
  });

  it('fails exact container inventory on inspect 500 without leaking Docker response', async () => {
    request.mockResolvedValueOnce(dockerReply(200, [{ Id: id, Labels: labels('assessment-stager') }]));
    request.mockResolvedValueOnce(dockerReply(500, { private: 'daemon secret' }));
    const result = await operation('container.listManaged', exact('assessment-stager'));
    expect(result).toEqual({ status: 502, body: {
      error: 'DOCKER_UNAVAILABLE', message: 'assessment inventory could not be proven complete',
    } });
  });

  it('rejects a container whose inspected resource differs from its exact list identity', async () => {
    request.mockResolvedValueOnce(dockerReply(200, [{ Id: id, Labels: labels('assessment-stager') }]));
    request.mockResolvedValueOnce(dockerReply(200, { Id: id, Config: {
      Labels: labels('assessment-runner'),
    } }));
    expect(await operation('container.listManaged', exact('assessment-stager'))).toEqual({
      status: 403, body: { error: 'FORBIDDEN_POLICY', message: 'assessment inventory ownership is not exact' },
    });
  });

  it.each(['invalid managed marker', 'mismatched resource'])(
    'fails exact volume inventory on %s', async (kind) => {
      request.mockResolvedValueOnce(dockerReply(200, { Volumes: [{ Name: 'qg-be9-source-test',
        Labels: { ...labels('assessment-source'), ...(kind === 'invalid managed marker'
          ? { 'io.quarangate.managed': 'false' }
          : { 'io.quarangate.resource': 'assessment-evidence' }) },
      }] }));
      expect(await operation('volume.listManaged', exact('assessment-source'))).toEqual({
        status: 403, body: { error: 'FORBIDDEN_POLICY', message: 'assessment inventory ownership is not exact' },
      });
    },
  );

  it('preserves invisible foreign targets for broad discovery', async () => {
    request.mockResolvedValueOnce(dockerReply(200, [{ Id: id, Labels: {} }]));
    request.mockResolvedValueOnce(dockerReply(200, { Id: id, Name: '/foreign', Config: { Labels: {} } }));
    expect(await operation('container.listManaged', {})).toEqual({ status: 200, body: [] });
  });
});
