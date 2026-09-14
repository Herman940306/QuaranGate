import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const servers: http.Server[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function runSoak(environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/mcp-soak.mjs'], {
      cwd: repoRoot,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function startMcpServer(
  expectedBearer: string,
  responseType: 'json' | 'sse' = 'sse',
  hostname = '127.0.0.1',
): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body) as { id: number };
      expect(req.headers.authorization).toBe(`Bearer ${expectedBearer}`);
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'test', version: '1' } },
      });
      if (responseType === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${payload}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  return `http://${hostname}:${address.port}/mcp`;
}

describe('MCP soak script', () => {
  it('performs a bounded concurrent initialize soak without disclosing the bearer', async () => {
    const bearer = 'TEST_BEARER_MUST_NOT_APPEAR';
    const url = await startMcpServer(bearer);
    const directory = mkdtempSync(path.join(tmpdir(), 'qg-mcp-soak-'));
    tempDirectories.push(directory);
    const bearerFile = path.join(directory, 'bearer');
    writeFileSync(bearerFile, `${bearer}\n`, { mode: 0o600 });
    chmodSync(bearerFile, 0o600);

    const result = await runSoak({
      MCP_BEARER_FILE: bearerFile,
      MCP_SOAK_URL: url,
      MCP_SOAK_ATTEMPTS: '5',
      MCP_SOAK_CONCURRENCY: '2',
      MCP_SOAK_TIMEOUT_MS: '5000',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(bearer);
    expect(JSON.parse(result.stdout)).toMatchObject({ attempts: 5, passes: 5, failureCount: 0, concurrency: 2 });
  });

  it('accepts a JSON initialize response for compatibility', async () => {
    const bearer = 'TEST_JSON_BEARER_MUST_NOT_APPEAR';
    const url = await startMcpServer(bearer, 'json');
    const directory = mkdtempSync(path.join(tmpdir(), 'qg-mcp-soak-'));
    tempDirectories.push(directory);
    const bearerFile = path.join(directory, 'bearer');
    writeFileSync(bearerFile, `${bearer}\n`, { mode: 0o600 });
    chmodSync(bearerFile, 0o600);

    const result = await runSoak({
      MCP_BEARER_FILE: bearerFile,
      MCP_SOAK_URL: url,
      MCP_SOAK_ATTEMPTS: '1',
      MCP_SOAK_CONCURRENCY: '1',
      MCP_SOAK_TIMEOUT_MS: '5000',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(bearer);
    expect(JSON.parse(result.stdout)).toMatchObject({ attempts: 1, passes: 1, failureCount: 0, concurrency: 1 });
  });

  it('pins hostname resolution to an explicit IP without changing the request URL', async () => {
    const bearer = 'TEST_PINNED_BEARER_MUST_NOT_APPEAR';
    const url = await startMcpServer(bearer, 'sse', 'localhost');
    const directory = mkdtempSync(path.join(tmpdir(), 'qg-mcp-soak-'));
    tempDirectories.push(directory);
    const bearerFile = path.join(directory, 'bearer');
    writeFileSync(bearerFile, `${bearer}\n`, { mode: 0o600 });
    chmodSync(bearerFile, 0o600);

    const result = await runSoak({
      MCP_BEARER_FILE: bearerFile,
      MCP_SOAK_URL: url,
      MCP_SOAK_RESOLVE_IP: '127.0.0.1',
      MCP_SOAK_ATTEMPTS: '1',
      MCP_SOAK_CONCURRENCY: '1',
      MCP_SOAK_TIMEOUT_MS: '5000',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(bearer);
    expect(JSON.parse(result.stdout)).toMatchObject({
      attempts: 1,
      passes: 1,
      failureCount: 0,
      resolveIp: '127.0.0.1',
    });
  });

  it('rejects an invalid explicit resolve IP before making requests', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qg-mcp-soak-'));
    tempDirectories.push(directory);
    const bearerFile = path.join(directory, 'bearer');
    writeFileSync(bearerFile, 'not-a-real-token\n', { mode: 0o600 });
    chmodSync(bearerFile, 0o600);

    const result = await runSoak({
      MCP_BEARER_FILE: bearerFile,
      MCP_SOAK_RESOLVE_IP: 'not-an-ip',
      MCP_SOAK_ATTEMPTS: '1',
    });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('FAIL: MCP_SOAK_RESOLVE_IP must be a valid IPv4 or IPv6 address\n');
    expect(result.stderr).not.toContain('not-a-real-token');
  });

  it('rejects a bearer file readable by group or other users', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qg-mcp-soak-'));
    tempDirectories.push(directory);
    const bearerFile = path.join(directory, 'bearer');
    writeFileSync(bearerFile, 'not-a-real-token\n', { mode: 0o644 });
    chmodSync(bearerFile, 0o644);

    const result = await runSoak({ MCP_BEARER_FILE: bearerFile, MCP_SOAK_ATTEMPTS: '1' });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('FAIL: MCP_BEARER_FILE must not be accessible by group or other users\n');
    expect(result.stderr).not.toContain('not-a-real-token');
  });
});
