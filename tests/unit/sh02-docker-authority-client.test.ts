import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd();
describe('SH-02 broker client boundary', () => {
  it('uses only named broker operation endpoint, never the Docker socket', () => {
    const raw = readFileSync(join(root, 'src/docker-authority/client.ts'), 'utf8');
    expect(raw).toContain("path: '/v1/operation'");
    expect(raw).toContain('DockerAuthorityOperation');
    expect(raw).not.toContain('/var/run/docker.sock');
    expect(raw).not.toContain('socketPath');
  });
  it('authenticates every operation and fails if token is absent', () => {
    const raw = readFileSync(join(root, 'src/docker-authority/client.ts'), 'utf8');
    expect(raw).toContain("'x-internal-token': TOKEN");
    expect(raw).toContain('if (!TOKEN)');
  });
});
