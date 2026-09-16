import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('SH-11 Docker broker hostile-world wiring', () => {
  const server = readFileSync('src/docker-authority/server.ts','utf8');
  const policy = readFileSync('src/docker-authority/policy.ts','utf8');

  it('revalidates every mounted volume from Docker state before container creation', () => {
    expect(server).toContain('for(const mount of managedVolumeMounts(body))');
    expect(server).toContain('const volume=await managedVolume(mount.Source)');
    expect(server).toContain('validateManagedVolumeAttachment(containerIdentity,volume.identity,mount)');
    const validateAt = server.indexOf('validateManagedVolumeAttachment(containerIdentity,volume.identity,mount)');
    const createAt = server.indexOf("/containers/create?name=");
    expect(validateAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(validateAt);
  });

  it('revalidates network and container identities before second-network attachment', () => {
    expect(server).toContain('const network=await managedNetwork(String(p.network))');
    expect(server).toContain('const container=await assertManagedContainer(String(p.container))');
    expect(server).toContain('validateManagedNetworkAttachment(network.identity,container.identity)');
  });

  it('validates Docker exec create payloads before forwarding them to the daemon', () => {
    expect(policy).toContain("if (req.op === 'container.execManaged' && payload.action === 'create') validateManagedExecCreate(payload.body)");
    expect(policy).toContain("const allowed = new Set(['AttachStdout','AttachStderr','Tty','Cmd','WorkingDir','Env','User'])");
  });


  it('applies resource-role policy to managed exec/archive after Docker-state inspection', () => {
    expect(server).toContain('const identity=managedIdentityFromTrustedContainer(c);if(identity)validateManagedExecForIdentity(identity,body)');
    expect(server).toContain("if(identity)validateManagedArchivePath(identity,'write',p.path)");
    expect(server).toContain("if(identity)validateManagedArchivePath(identity,'read',p.path)");
    expect(policy).toContain("if (identity.resource !== 'applier') deny('Docker exec is forbidden for this managed resource role')");
    expect(policy).toContain("managed archive write path is outside the resource role contract");
  });

  it('keeps raw daemon forwarding unavailable and the socket confined to broker source', () => {
    expect(server).not.toMatch(/q\.body\.(method|path)|payload\.(method|path)/u);
    for (const file of ['src/executor/docker.ts','src/docker-authority/client.ts']) {
      expect(readFileSync(file,'utf8')).not.toContain('/var/run/docker.sock');
    }
  });
});
