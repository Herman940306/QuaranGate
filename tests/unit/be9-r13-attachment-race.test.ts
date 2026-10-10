import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { validateManagedContainerCreate } from '../../src/docker-authority/policy.js';

const { request, routes } = vi.hoisted(() => ({
  request: vi.fn(), routes: new Map<string, (req: any, res: any) => Promise<void>>(),
}));
vi.mock('undici', () => ({ Pool: class { request = request; } }));
vi.mock('express', () => ({ default: Object.assign(() => ({
  use: vi.fn(), get: vi.fn(), listen: vi.fn(),
  post: (path: string, handler: (req: any, res: any) => Promise<void>) => routes.set(path, handler),
}), { json: () => vi.fn() }) }));

const A = `assessment_${'a'.repeat(24)}`;
const B = `assessment_${'b'.repeat(24)}`;
const AJ = `job_${'c'.repeat(32)}`;
const BJ = `job_${'d'.repeat(32)}`;
const ID = 'e'.repeat(64);
const VOLUME = 'qg-be9-source-r13-attachment';
const labels = (resource: string, assessment = A, job = AJ) => ({
  'io.quarangate.managed': 'true', 'io.quarangate.resource': resource,
  'io.quarangate.assessment': assessment, 'io.quarangate.job': job,
});
const mount = { Type: 'volume', Source: VOLUME, Target: '/workspace', ReadOnly: true };
const runner = {
  Image: `sha256:${'f'.repeat(64)}`, User: '1000:1000',
  Labels: labels('assessment-runner'), NetworkDisabled: true,
  HostConfig: {
    AutoRemove: false, Privileged: false, ReadonlyRootfs: true,
    CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'],
    GroupAdd: [], Devices: [], DeviceRequests: [], PidMode: '',
    IpcMode: 'private', UTSMode: '', UsernsMode: '', NetworkMode: 'none',
    Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024,
    NanoCpus: 500_000_000, PidsLimit: 32,
    Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
    Mounts: [mount], Binds: [],
  },
};
const reply = (statusCode: number, value: unknown) => ({
  statusCode, headers: {},
  body: Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), {
    arrayBuffer: async () => Buffer.from(JSON.stringify(value)),
  }),
});
async function invoke(op: string, payload: unknown) {
  let status = 200;
  let body: unknown;
  await routes.get('/v1/operation')!({ body: { op, payload } }, {
    status(n: number) { status = n; return this; },
    json(v: unknown) { body = v; return this; },
  });
  return { status, body };
}

describe('BE9 R13 assessment volume attachment lock', () => {
  beforeEach(async () => {
    vi.resetModules(); request.mockReset(); routes.clear();
    await import('../../src/docker-authority/server.js');
  });

  it('prevents removal and same-name B recreation while A container POST is awaiting Docker', async () => {
    expect(() => validateManagedContainerCreate(runner)).not.toThrow();
    const sequence: string[] = [];
    let entered!: () => void;
    const posted = new Promise<void>(resolve => { entered = resolve; });
    let release!: (x: ReturnType<typeof reply>) => void;
    const pendingPost = new Promise<ReturnType<typeof reply>>(resolve => { release = resolve; });
    request.mockImplementation((o: { method: string; path: string }) => {
      if (o.method === 'GET' && o.path.includes('/volumes/')) {
        sequence.push('GET volume');
        return reply(200, { Name: VOLUME, Labels: labels('assessment-source') });
      }
      if (o.method === 'POST' && o.path.includes('/containers/create')) {
        sequence.push('POST container');
        entered();
        return pendingPost;
      }
      if (o.method === 'GET' && o.path.includes('/containers/')) {
        sequence.push('GET created container');
        return reply(200, {
          Id: ID, Config: { Labels: runner.Labels }, HostConfig: { Mounts: [mount] },
          Mounts: [{ Type: 'volume', Name: VOLUME, Destination: '/workspace', RW: false }],
        });
      }
      if (o.method === 'DELETE' && o.path.includes('/volumes/')) {
        sequence.push('DELETE A volume');
        return reply(204, {});
      }
      if (o.method === 'POST' && o.path.includes('/volumes/create')) {
        sequence.push('POST B volume');
        return reply(201, { Name: VOLUME, Labels: labels('assessment-source', B, BJ) });
      }
      throw new Error(`unexpected Docker request ${o.method} ${o.path}`);
    });
    const creatingA = invoke('container.createManaged', { name: 'qg-r13-assessment-runner', body: runner });
    await posted;
    const deletingA = invoke('volume.removeManaged', {
      name: VOLUME, expectedAssessmentSourceOwner: { assessmentId: A, executionId: AJ },
    });
    const creatingB = deletingA.then(() => invoke('volume.createManaged', {
      name: VOLUME, labels: labels('assessment-source', B, BJ),
    }));
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(sequence).toEqual(['GET volume', 'POST container']);
    } finally {
      release(reply(201, { Id: ID, Warnings: [] }));
      await Promise.allSettled([creatingA, deletingA, creatingB]);
    }
    expect(sequence.indexOf('DELETE A volume')).toBeGreaterThan(sequence.indexOf('POST container'));
    expect(sequence.indexOf('POST B volume')).toBeGreaterThan(sequence.indexOf('DELETE A volume'));
  });

  it.each(['owner', 'mount', 'id'])('denies created assessment container with unproved %s', async kind => {
    let requests = 0;
    request.mockImplementation((o: { method: string; path: string }) => {
      requests++;
      if (o.method === 'GET' && o.path.includes('/volumes/')) {
        return reply(200, { Name: VOLUME, Labels: labels('assessment-source') });
      }
      if (o.method === 'POST' && o.path.includes('/containers/create')) {
        return reply(201, { Id: kind === 'id' ? 'invalid' : ID });
      }
      if (o.method === 'GET' && o.path.includes('/containers/')) {
        return reply(200, {
          Id: ID,
          Config: { Labels: kind === 'owner' ? labels('assessment-runner', B, BJ) : runner.Labels },
          Mounts: [{ Type: 'volume', Name: kind === 'mount' ? 'foreign-volume' : VOLUME,
            Destination: '/workspace', RW: false }],
        });
      }
      throw new Error('unexpected Docker operation');
    });
    const result = await invoke('container.createManaged', { name: 'qg-r13-bad-attachment', body: runner });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(result.body)).not.toContain(ID);
    expect(requests).toBeGreaterThan(0);
  });

  it('releases the volume lock after an ambiguous create request failure without leaking daemon error', async () => {
    let posts = 0;
    request.mockImplementation((o: { method: string; path: string }) => {
      if (o.method === 'GET' && o.path.includes('/volumes/')) {
        return reply(200, { Name: VOLUME, Labels: labels('assessment-source') });
      }
      if (o.method === 'POST' && o.path.includes('/containers/create')) {
        posts++;
        throw new Error('PRIVATE_DOCKER_ERROR');
      }
      if (o.method === 'DELETE' && o.path.includes('/volumes/')) return reply(204, {});
      throw new Error('unexpected Docker operation');
    });
    const failed = await invoke('container.createManaged', { name: 'qg-r13-ambiguous', body: runner });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain('PRIVATE_DOCKER_ERROR');
    const removed = await invoke('volume.removeManaged', {
      name: VOLUME, expectedAssessmentSourceOwner: { assessmentId: A, executionId: AJ },
    });
    expect(removed.status).toBe(200);
    expect(posts).toBe(1);
  });

  it('denies starting a previously created A container when current volume is owned by B', async () => {
    let started = false;
    request.mockImplementation((o: { method: string; path: string }) => {
      if (o.method === 'GET' && o.path.includes('/containers/')) {
        return reply(200, {
          Id: ID, Config: { Labels: runner.Labels },
          Mounts: [{ Type: 'volume', Name: VOLUME, Destination: '/workspace', RW: false }],
        });
      }
      if (o.method === 'GET' && o.path.includes('/volumes/')) {
        return reply(200, { Name: VOLUME, Labels: labels('assessment-source', B, BJ) });
      }
      if (o.method === 'POST' && o.path.endsWith('/start')) {
        started = true; return reply(204, {});
      }
      throw new Error('unexpected Docker operation');
    });
    const result = await invoke('container.startManaged', { id: ID });
    expect(result.status).toBe(403);
    expect(started).toBe(false);
  });

  it('starts A only when its current volume remains exactly A-owned under the shared lock', async () => {
    const actions: string[] = [];
    request.mockImplementation((o: { method: string; path: string }) => {
      if (o.method === 'GET' && o.path.includes('/containers/')) {
        actions.push('GET container');
        return reply(200, {
          Id: ID, Config: { Labels: runner.Labels },
          Mounts: [{ Type: 'volume', Name: VOLUME, Destination: '/workspace', RW: false }],
        });
      }
      if (o.method === 'GET' && o.path.includes('/volumes/')) {
        actions.push('GET volume');
        return reply(200, { Name: VOLUME, Labels: labels('assessment-source') });
      }
      if (o.method === 'POST' && o.path.endsWith('/start')) {
        actions.push('POST start'); return reply(204, {});
      }
      throw new Error('unexpected Docker operation');
    });
    const result = await invoke('container.startManaged', { id: ID });
    expect(result.status).toBe(200);
    expect(actions.filter(x => x === 'GET volume')).toHaveLength(2);
    expect(actions.filter(x => x === 'POST start')).toHaveLength(1);
  });

  it('serializes reversed two-volume mount orders without deadlock for non-assessment callers', async () => {
    const workspaceName = 'qg-r13-workspace';
    const secretName = 'qg-r13-secret';
    const ordinary = (resource: string) => ({
      'io.quarangate.managed': 'true', 'io.quarangate.resource': resource,
      'io.quarangate.job': AJ,
    });
    const work = { Type: 'volume', Source: workspaceName, Target: '/workspace', ReadOnly: true };
    const secret = { Type: 'volume', Source: secretName, Target: '/run/secrets', ReadOnly: true };
    const make = (mounts: Array<typeof work>) => ({
      ...runner, Labels: ordinary('runner'),
      HostConfig: { ...runner.HostConfig, Mounts: mounts },
    });
    const firstBody = make([work, secret]);
    const reverseBody = make([secret, work]);
    expect(() => validateManagedContainerCreate(firstBody)).not.toThrow();
    expect(() => validateManagedContainerCreate(reverseBody)).not.toThrow();
    const sequence: string[] = [];
    let entered!: () => void;
    const posted = new Promise<void>(resolve => { entered = resolve; });
    let release!: (r: ReturnType<typeof reply>) => void;
    const held = new Promise<ReturnType<typeof reply>>(resolve => { release = resolve; });
    request.mockImplementation((o: { method: string; path: string }) => {
      if (o.method === 'GET' && o.path.includes('/volumes/')) {
        const name = decodeURIComponent(o.path.split('/').at(-1)!);
        sequence.push('GET ' + name);
        return reply(200, { Name: name, Labels: ordinary(name === workspaceName ? 'workspace' : 'secret') });
      }
      if (o.method === 'POST' && o.path.includes('/containers/create')) {
        if (o.path.includes('name=first')) {
          sequence.push('POST first'); entered(); return held;
        }
        sequence.push('POST second'); return reply(201, { Id: ID });
      }
      throw new Error('unexpected Docker operation');
    });
    const first = invoke('container.createManaged', { name: 'first', body: firstBody });
    await posted;
    const second = invoke('container.createManaged', { name: 'second', body: reverseBody });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(sequence).toEqual(['GET ' + workspaceName, 'GET ' + secretName, 'POST first']);
    } finally {
      release(reply(201, { Id: ID }));
      await Promise.allSettled([first, second]);
    }
    expect(sequence).toEqual([
      'GET ' + workspaceName, 'GET ' + secretName, 'POST first',
      'GET ' + secretName, 'GET ' + workspaceName, 'POST second',
    ]);
  });
});
