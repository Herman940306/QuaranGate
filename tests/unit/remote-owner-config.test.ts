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
    expect(script).toContain('--env-file');
    expect(script).toContain('mutable QuaranGate image refused');
    expect(script).toContain('compose.ollama.yaml');
    expect(script).not.toMatch(/docker\s+build|docker\s+pull/);
  });

  it('candidate deployment builds one local artifact, preserves rollback state, and never pulls', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain('build --no-cache gateway');
    expect(script).toContain('docker tag "$NEW_GATEWAY_IMAGE" "$NEW_EXECUTOR_IMAGE"');
    expect(script).toContain('rollback_attempted');
    expect(script).toContain('--no-build --pull never');
    expect(script).toContain('compose.ollama.yaml');
    expect(script).not.toMatch(/docker\s+pull/);
  });

  it('candidate deployment builds candidate source but mounts live runtime config from the main operator root', () => {
    const deploy = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(deploy).toContain('BUILD_QG=(docker compose');
    expect(deploy).toContain('-f "$REPO_ROOT/compose.yaml"');
    expect(deploy).toContain('QG_FILES=(-f "$MAIN_ROOT/compose.yaml")');
    expect(deploy).toContain('$MAIN_ROOT/config/clients.yaml');
    expect(deploy).toContain('$MAIN_ROOT/config/bridge.yaml');
  });

  it('persisted image verification is immune to stale inherited image exports and rollback is verified', () => {
    const deploy = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(deploy).toContain("expected = {'GATEWAY_IMAGE': sys.argv[2], 'EXECUTOR_IMAGE': sys.argv[3]}");
    expect(deploy).toContain('GATEWAY_IMAGE="$NEW_GATEWAY_IMAGE" EXECUTOR_IMAGE="$NEW_EXECUTOR_IMAGE"');
    expect(deploy).toContain('REMOTE_OWNER_ROLLBACK=PASS');
    expect(deploy).toContain('rollback_gateway_image');
    expect(deploy).toContain('rollback_executor_image');
  });

  it('linked-worktree recovery resolves the operator runtime root before composing QuaranGate', () => {
    for (const name of ['remote-owner-start.sh', 'remote-owner-health.sh', 'remote-owner-infra-acceptance.sh']) {
      const script = readFileSync(join(root, 'scripts', name), 'utf8');
      expect(script, name).toContain('RUNTIME_ROOT="$REPO_ROOT"');
      expect(script, name).toContain('$RUNTIME_ROOT/config/clients.yaml');
      expect(script, name).toContain('QG_FILES=(-f "$RUNTIME_ROOT/compose.yaml")');
    }
  });

  it('preserves an explicitly configured Copilot overlay across unattended start, health, and infra acceptance', () => {
    for (const name of ['remote-owner-start.sh', 'remote-owner-health.sh', 'remote-owner-infra-acceptance.sh']) {
      const script = readFileSync(join(root, 'scripts', name), 'utf8');
      expect(script, name).toContain("AGENT_COPILOT_RUNNER_IMAGE");
      expect(script, name).toContain('compose.copilot.yaml');
      expect(script, name).toContain("Copilot is configured but compose.copilot.yaml is missing");
      expect(script, name).toContain('QG_FILES+=(-f "$copilot_overlay")');
    }
  });

  it('candidate deployment uses candidate Copilot source while rollback retains the runtime overlay', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain("AGENT_COPILOT_RUNNER_IMAGE");
    expect(script).toContain('[[ -f "$MAIN_ROOT/compose.copilot.yaml" ]]');
    expect(script).toContain('[[ -f "$REPO_ROOT/compose.copilot.yaml" ]]');
    expect(script).toContain('BASE_QG_FILES+=(-f "$MAIN_ROOT/compose.copilot.yaml")');
    expect(script).toContain('QG_FILES+=(-f "$REPO_ROOT/compose.copilot.yaml")');
    expect(script).not.toMatch(/DEPLOY_SERVICES=.*copilot/);
  });

  it('candidate validator resolves live config correctly from either main or a linked worktree', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-candidate-validate.sh'), 'utf8');
    expect(script).toContain('MAIN_ROOT="$ROOT"');
    expect(script).toContain('$ROOT/../../config/clients.yaml');
    expect(script).toContain('MAIN_ROOT="$(cd "$ROOT/../.." && pwd)"');
  });

  it('Windows autostart uses a non-elevated local launcher that logs before entering WSL', () => {
    const installer = readFileSync(join(root, 'scripts', 'windows', 'Install-QuaranGateRemoteOwnerAutostart.ps1'), 'utf8');
    const wrapper = readFileSync(join(root, 'scripts', 'remote-owner-autostart.sh'), 'utf8');
    expect(installer).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(installer).toContain('RemoteOwnerAutostart.ps1');
    expect(installer).toContain('remote-owner-task.log');
    expect(installer).toContain('REMOTE_OWNER_WINDOWS_TASK=START');
    expect(installer).toContain('REMOTE_OWNER_WINDOWS_TASK=PASS');
    expect(installer).toContain("'--exec', '/bin/bash', '$linuxEntrypoint'");
    expect(installer).toContain('-RunLevel Limited');
    expect(installer).not.toMatch(/mcpb_|INTERNAL_TOKEN|API_KEY=/);
    expect(wrapper).toContain('remote-owner-autostart.log');
    expect(wrapper).toContain('chmod 600');
    expect(wrapper).toContain('remote-owner-start.sh');
    expect(wrapper).toContain('REMOTE_OWNER_AUTOSTART=PASS');
    expect(wrapper).not.toMatch(/mcpb_|INTERNAL_TOKEN|API_KEY=/);
  });
});
