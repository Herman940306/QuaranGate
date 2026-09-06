import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const root = resolve(import.meta.dirname, '../..');

function compose(): any {
  return YAML.parse(readFileSync(join(root, 'projects-work-target', 'compose.yaml'), 'utf8'));
}

describe('remote owner projects-work hard boundary', () => {
  it('mounts only the approved projects root into /workspace read/write', () => {
    const c = compose();
    const service = c.services.work;
    expect(service.volumes).toEqual(['${PROJECTS_ROOT:?set PROJECTS_ROOT}:/workspace:rw']);
    expect(JSON.stringify(service.volumes)).not.toContain('/home/herman');
  });

  it('does not expose Docker administration to the umbrella work target', () => {
    const raw = readFileSync(join(root, 'projects-work-target', 'compose.yaml'), 'utf8');
    expect(raw).not.toContain('/var/run/docker.sock:');
    const service = compose().services.work;
    expect(service.privileged).not.toBe(true);
    expect(service.cap_add ?? []).toEqual([]);
    expect(service.cap_drop).toEqual(['ALL']);
    expect(service.security_opt).toContain('no-new-privileges:true');
  });

  it('is restartable without implicit pull/build behavior in the recovery script', () => {
    expect(compose().services.work.restart).toBe('unless-stopped');
    const script = readFileSync(join(root, 'scripts', 'remote-owner-start.sh'), 'utf8');
    expect(script).toContain('--no-build --pull never');
    expect(script).not.toMatch(/docker\s+build|docker\s+pull/);
  });

  it('Windows autostart invokes only the bounded WSL recovery entrypoint at owner logon', () => {
    const script = readFileSync(join(root, 'scripts', 'windows', 'Install-QuaranGateRemoteOwnerAutostart.ps1'), 'utf8');
    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(script).toContain('./scripts/remote-owner-start.sh');
    expect(script).not.toMatch(/mcpb_|INTERNAL_TOKEN|API_KEY=/);
  });
});
