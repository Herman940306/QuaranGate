import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock('undici', () => ({
  Pool: class MockPool {
    request = requestMock;
  },
}));

describe('Docker Authority streaming client error mapping', () => {
  beforeEach(() => {
    vi.resetModules();
    requestMock.mockReset();
    process.env.DOCKER_AUTHORITY_URL = 'http://docker-authority.test';
    process.env.DOCKER_AUTHORITY_TOKEN = 'authority-token';
    process.env.INTERNAL_TOKEN = 'executor-token';
  });

  afterEach(() => {
    delete process.env.DOCKER_AUTHORITY_URL;
    delete process.env.DOCKER_AUTHORITY_TOKEN;
    delete process.env.INTERNAL_TOKEN;
  });

  it('preserves archive-read 404 as FILE_NOT_FOUND', async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 404,
      body: {
        text: async () => JSON.stringify({
          error: 'FILE_NOT_FOUND',
          message: 'archive read failed',
        }),
      },
      headers: {},
    });

    const { authorityStream } = await import('../../src/docker-authority/client.js');

    await expect(authorityStream(
      'container.archiveReadManaged',
      { containerId: 'abc', path: '/evidence/missing.txt' },
    )).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('keeps archive-read 403 mapped to FORBIDDEN_POLICY', async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 403,
      body: {
        text: async () => JSON.stringify({
          error: 'FORBIDDEN_POLICY',
          message: 'path outside role contract',
        }),
      },
      headers: {},
    });

    const { authorityStream } = await import('../../src/docker-authority/client.js');

    await expect(authorityStream(
      'container.archiveReadManaged',
      { containerId: 'abc', path: '/' },
    )).rejects.toMatchObject({
      code: 'FORBIDDEN_POLICY',
      httpStatus: 403,
    });
  });

  it('keeps non-archive stream 404 fail-closed as DOCKER_UNAVAILABLE', async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 404,
      body: {
        text: async () => JSON.stringify({
          error: 'DOCKER_UNAVAILABLE',
          message: 'exec not found',
        }),
      },
      headers: {},
    });

    const { authorityStream } = await import('../../src/docker-authority/client.js');

    await expect(authorityStream(
      'container.execManaged',
      { action: 'start', execId: 'missing' },
    )).rejects.toMatchObject({
      code: 'DOCKER_UNAVAILABLE',
      httpStatus: 502,
    });
  });
});
