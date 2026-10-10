import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

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
  statusCode, headers: {}, body: Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), {
    arrayBuffer: async () => Buffer.from(JSON.stringify(value)),
  }),
});
const exactFailure = { status: 502, body: {
  error: 'DOCKER_UNAVAILABLE', message: 'assessment inventory could not be proven complete',
} };

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

  it.each(['container.listManaged', 'volume.listManaged'])(
    'rejects 129 exact %s rows before inspecting any container', async (op) => {
      const rows = Array.from({ length: 129 }, (_, n) => op.startsWith('container')
        ? { Id: n.toString(16).padStart(64, '0'), Labels: labels('assessment-stager') }
        : { Name: `qg-be9-source-${n}`, Labels: labels('assessment-source') });
      request.mockResolvedValueOnce(dockerReply(200, op.startsWith('container') ? rows : { Volumes: rows }));
      expect(await operation(op, exact(op.startsWith('container') ? 'assessment-stager' : 'assessment-source'))).toEqual(exactFailure);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['container.listManaged', 'volume.listManaged'])(
    'allows 128 exact %s rows with bounded replies', async (op) => {
      const isContainer = op.startsWith('container');
      const resource = isContainer ? 'assessment-stager' : 'assessment-source';
      const rows = Array.from({ length: 128 }, (_, n) => isContainer
        ? { Id: n.toString(16).padStart(64, '0'), Labels: labels(resource) }
        : { Name: `qg-be9-source-${n}`, Labels: labels(resource) });
      request.mockResolvedValueOnce(dockerReply(200, isContainer ? rows : { Volumes: rows }));
      if (isContainer) for (const row of rows) request.mockResolvedValueOnce(dockerReply(200, {
        Config: { Labels: row.Labels },
      }));
      expect(await operation(op, exact(resource))).toEqual({ status: 200,
        body: isContainer ? rows : { Volumes: rows } });
      expect(request).toHaveBeenCalledTimes(isContainer ? 129 : 1);
    },
  );

  it('aborts exact inventory on an oversized streaming chunk without reading later chunks', async () => {
    let chunksProduced = 0;
    const stream = Readable.from((async function* () {
      yield Buffer.alloc(2 * 1024 * 1024 + 1);
      for (let n = 0; n < 100; n++) { chunksProduced++; yield Buffer.from('private'); }
    })());
    request.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: stream });
    expect(await operation('container.listManaged', exact('assessment-stager'))).toEqual(exactFailure);
    expect(chunksProduced).toBeLessThan(100);
    expect(stream.destroyed).toBe(true);
  });

  it('aborts oversized assessment-source volume inventory on the strict recovery selector', async () => {
    let laterChunks = 0;
    const stream = Readable.from((async function* () {
      yield Buffer.alloc(2 * 1024 * 1024 + 1);
      for (let n = 0; n < 30; n++) {
        laterChunks++;
        yield Buffer.from('untrusted Docker content');
      }
    })());
    request.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: stream });
    const result = await operation('volume.listManaged', exact('assessment-source'));
    expect(result).toEqual(exactFailure);
    expect(laterChunks).toBeLessThan(30);
    expect(stream.destroyed).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('serializes same-name creation against a pending checked assessment deletion', async () => {
    const volumeName = 'qg-be9-source-owned';
    const ownerB = {
      ...labels('assessment-source'),
      'io.quarangate.job': `job_${'e'.repeat(32)}`,
      'io.quarangate.assessment': `assessment_${'f'.repeat(24)}`,
    };
    const methods: string[] = [];
    let releaseGet!: (reply: unknown) => void;
    let observedGet!: () => void;
    const enteredGet = new Promise<void>((resolve) => { observedGet = resolve; });
    const heldGet = new Promise<unknown>((resolve) => { releaseGet = resolve; });
    request.mockImplementation((options: { method: string; path: string }) => {
      methods.push(options.method);
      if (options.method === 'GET') { observedGet(); return heldGet; }
      if (options.method === 'DELETE') return dockerReply(204, {});
      if (options.method === 'POST') return dockerReply(201, { Name: volumeName, Labels: ownerB });
      throw new Error('unexpected Docker operation');
    });
    const handler = routes.get('/v1/operation')!;
    const invoke = async (op: string, payload: unknown) => {
      let status = 200;
      await handler({ body: { op, payload } }, {
        status(value: number) { status = value; return this; },
        json(_value: unknown) { return this; },
      });
      return status;
    };
    const deleting = invoke('volume.removeManaged', {
      name: volumeName, expectedAssessmentSourceOwner: {
        assessmentId: assessment, executionId: job,
      },
    });
    await enteredGet;
    const creatingB = invoke('volume.createManaged', { name: volumeName, labels: ownerB });
    await Promise.resolve();
    // Broker-controlled B creation must not overtake A's inspected deletion.
    expect(methods).toEqual(['GET']);
    releaseGet(dockerReply(200, { Name: volumeName, Labels: labels('assessment-source') }));
    expect(await deleting).toBe(200);
    expect(await creatingB).toBe(200);
    expect(methods).toEqual(['GET', 'DELETE', 'POST']);
  });

  it('never issues a name-only DELETE when volume inspection proves absence', async () => {
    request.mockResolvedValueOnce(dockerReply(404, { message: 'not found' }));
    const handler = routes.get('/v1/operation')!;
    let status = 200;
    await handler({ body: { op: 'volume.removeManaged', payload: {
      name: 'qg-be9-source-absent',
      expectedAssessmentSourceOwner: { assessmentId: assessment, executionId: job },
    } } }, {
      status(value: number) { status = value; return this; },
      json(_value: unknown) { return this; },
    });
    expect(status).toBe(200);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].method).toBe('GET');
  });

  it('rejects create responses that return a different assessment volume generation', async () => {
    const volumeName = 'qg-be9-source-existing';
    request.mockResolvedValueOnce(dockerReply(201, {
      Name: volumeName, Labels: {
        ...labels('assessment-source'),
        'io.quarangate.job': `job_${'f'.repeat(32)}`,
      },
    }));
    const handler = routes.get('/v1/operation')!;
    let status = 200;
    let body: unknown;
    await handler({ body: { op: 'volume.createManaged', payload: {
      name: volumeName, labels: labels('assessment-source'),
    } } }, {
      status(value: number) { status = value; return this; },
      json(value: unknown) { body = value; return this; },
    });
    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'FORBIDDEN_POLICY',
      message: 'assessment source volume creation ownership mismatch',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds exact container inspect and rejects duplicate identities', async () => {
    request.mockResolvedValueOnce(dockerReply(200, [{ Id: id, Labels: labels('assessment-stager') }]));
    const inspect = Readable.from([Buffer.alloc(2 * 1024 * 1024 + 1)]);
    request.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: inspect });
    expect(await operation('container.listManaged', exact('assessment-stager'))).toEqual(exactFailure);
    expect(inspect.destroyed).toBe(true);

    request.mockClear();
    request.mockResolvedValueOnce(dockerReply(200, Array.from({ length: 2 }, () => ({
      Id: id, Labels: labels('assessment-stager'),
    }))));
    expect(await operation('container.listManaged', exact('assessment-stager'))).toEqual(exactFailure);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses removal when assessment volume ownership is swapped to another allocation', async () => {
    const otherOwner = {
      ...labels('assessment-source'),
      'io.quarangate.job': `job_${'e'.repeat(32)}`,
      'io.quarangate.assessment': `assessment_${'f'.repeat(24)}`,
    };
    request.mockResolvedValueOnce(dockerReply(200, {
      Name: 'qg-be9-source-owned', Labels: otherOwner,
    }));
    const handler = routes.get('/v1/operation')!;
    let status = 200;
    let body: unknown;
    await handler({
      body: { op: 'volume.removeManaged', payload: {
        name: 'qg-be9-source-owned',
        expectedAssessmentSourceOwner: { assessmentId: assessment, executionId: job },
      } },
    }, {
      status(value: number) { status = value; return this; },
      json(value: unknown) { body = value; return this; },
    });
    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'FORBIDDEN_POLICY',
      message: 'assessment source volume ownership mismatch',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['content-length', 'malformed', 'status', 'stream error'])(
    'sanitizes exact inventory %s failures', async (kind) => {
      const secret = 'private Docker diagnostic';
      const body = kind === 'stream error'
        ? Readable.from((async function* () { throw new Error(secret); })())
        : Readable.from([Buffer.from(kind === 'malformed' ? '{' : secret)]);
      request.mockResolvedValueOnce({ statusCode: kind === 'status' ? 500 : 200,
        headers: kind === 'content-length' ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {}, body });
      const result = await operation('container.listManaged', exact('assessment-stager'));
      expect(result).toEqual(exactFailure);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(body.destroyed).toBe(true);
    },
  );
});
