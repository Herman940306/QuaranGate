import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('SH-11 Docker broker hostile-world wiring', () => {
  const server = readFileSync('src/docker-authority/server.ts','utf8');
  const policy = readFileSync('src/docker-authority/policy.ts','utf8');

  it('revalidates each named mount while holding the same lock used for volume mutation', () => {
    const containerCreateAt = server.indexOf("case 'container.createManaged':");
    const locksAt = server.indexOf('serializedVolumeMounts(mounts.map(m => m.Source)', containerCreateAt);
    const inspectAt = server.indexOf('await managedVolume(mount.Source)', locksAt);
    const validateAt = server.indexOf('validateManagedVolumeAttachment(containerIdentity, volume.identity, mount)', locksAt);
    const createAt = server.indexOf('/containers/create?name=', validateAt);
    const proofAt = server.indexOf('await proveAssessmentAttachment(id, containerIdentity, mounts)', createAt);
    expect(containerCreateAt).toBeGreaterThan(-1);
    expect(locksAt).toBeGreaterThan(containerCreateAt);
    expect(inspectAt).toBeGreaterThan(locksAt);
    expect(validateAt).toBeGreaterThan(inspectAt);
    expect(createAt).toBeGreaterThan(validateAt);
    expect(proofAt).toBeGreaterThan(createAt);
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


  it('returns the trusted inspect object directly instead of dereferencing a nonexistent wrapper', () => {
    expect(server).toContain("case 'container.inspectManaged': out=await assertContainer(String(p.id));break;");
    expect(server).not.toContain("assertContainer(String(p.id))).info");
  });

  it('resolves exec inspection authority from the exec record, never a missing caller containerId', () => {
    expect(server).toContain("case 'container.execManaged': {if(p.action==='create'){const c=await assertContainer(String(p.containerId));");
    expect(server).toContain("else if(p.action==='inspect'){out=await json('GET',`${API}/exec/${enc(p.execId)}/json`);await assertContainer(String(out.ContainerID));}");
    expect(server).not.toContain("case 'container.execManaged': {const c=await assertContainer(String(p.containerId));");
  });

  it('flushes validated exec-stream headers before waiting for the first body byte', () => {
    const execStart = server.indexOf("path:`${API}/exec/${enc(p.execId)}/start`");
    const statusCheck = server.indexOf('if(r.statusCode>=400)', execStart);
    const flush = server.indexOf('s.status(200);s.flushHeaders();(r.body as any).pipe(s);return;', execStart);
    expect(execStart).toBeGreaterThan(-1);
    expect(statusCheck).toBeGreaterThan(execStart);
    expect(flush).toBeGreaterThan(statusCheck);
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
