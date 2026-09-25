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
    expect(script).toContain('scripts/p10-offline-core-build.mjs');
    expect(script).toContain('--bundle "$BUNDLE_PATH"');
    expect(script).toContain("QUARANGATE_NPM_BUNDLE_PATH");
    expect(script).toContain('docker tag "$NEW_GATEWAY_IMAGE" "$NEW_DOCKER_AUTHORITY_IMAGE"');
    expect(script).toContain('docker tag "$NEW_GATEWAY_IMAGE" "$NEW_EXECUTOR_IMAGE"');
    expect(script).toContain("BASE_IMAGE='node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81'");
    expect(script).toContain('rollback_attempted');
    expect(script).toContain('--no-build --pull never');
    expect(script).toContain('compose.ollama.yaml');
    expect(script).not.toMatch(/docker\s+pull/);
  });

  it('migrates a pre-SH06 runtime without inventing a historical Docker-authority baseline', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain('OLD_DOCKER_AUTHORITY_PRESENT=${#legacy_authority_ids[@]}');
    expect(script).toContain("[[ ${#legacy_authority_ids[@]} -le 1 ]]");
    expect(script).toContain('if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 0 ]]');
    expect(script).toContain('rm -sf docker-authority');
    expect(script).toContain('elif [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 0 && ${#rollback_authority_ids[@]} -eq 0 ]]');
    expect(script).not.toContain("cannot derive one-time SH-06 Docker-authority baseline image");
  });

  it('deploys candidate topology against operator-relative binds and keeps legacy topology for rollback', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain('QG_FILES=(-f "$REPO_ROOT/compose.yaml")');
    expect(script).toContain('BASE_QG_FILES=(-f "$MAIN_ROOT/compose.yaml")');
    expect(script).toContain('--project-directory "$MAIN_ROOT"');
    expect(script).toContain('BASE_QG_FILES+=(-f "$github_rollback_overlay")');
    expect(script).toContain('QG_FILES+=(-f "$REPO_ROOT/compose.github.yaml")');
  });

  it('requires exact receipt binding before reusing existing current release refs', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain('existing release refs require absolute QUARANGATE_DEPLOY_RELEASE_RECEIPT');
    expect(script).toContain("doc.get('status') != 'PASS'");
    expect(script).toContain("source.get('commit') != rev");
    expect(script).toContain("source.get('tree') != tree");
    expect(script).toContain('release receipt lacks required core image roles');
    expect(script).toContain('existing release ref digest mismatch');
    expect(script).toContain("fail 'partial existing release ref set refused'");
  });

  it('rebinds final captured release IDs to the receipt and rechecks them at deployment selection', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    const receiptCheck = script.indexOf('existing release refs changed after receipt validation');
    const bindingFunction = script.indexOf('assert_candidate_image_bindings()');
    const controlledDeploy = script.indexOf("=== CONTROLLED DEPLOY ===");
    const deployRecheck = script.indexOf('assert_candidate_image_bindings', controlledDeploy);
    const immutableSelection = script.indexOf('export GATEWAY_IMAGE="$new_gateway_id" DOCKER_AUTHORITY_IMAGE="$new_authority_id" EXECUTOR_IMAGE="$new_executor_id"', controlledDeploy);
    const mutation = script.indexOf('mutated=1', controlledDeploy);
    expect(receiptCheck).toBeGreaterThanOrEqual(0);
    expect(bindingFunction).toBeGreaterThan(receiptCheck);
    expect(deployRecheck).toBeGreaterThan(controlledDeploy);
    expect(immutableSelection).toBeGreaterThan(deployRecheck);
    expect(mutation).toBeGreaterThan(immutableSelection);
    expect(script).toContain('candidate image tag retargeted before deployment selection');
  });

  it('resolves the operator root independently of sibling-worktree path assumptions and propagates it to infra acceptance', () => {
    const deploy = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(deploy).toContain('QUARANGATE_RUNTIME_ROOT');
    expect(deploy).toContain('git rev-parse --path-format=absolute --git-common-dir');
    expect(deploy).toContain("operator runtime root cannot be derived from candidate Git topology");
    expect(deploy).toContain("--resolve-runtime-root-only");
    expect(deploy).toContain('QUARANGATE_RUNTIME_ROOT="$MAIN_ROOT" QUARANGATE_RUNTIME_ENV="$RUNTIME_ENV"');
  });

  it('captures GitHub network state independently of service presence and removes only candidate-created networks', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    for (const key of [
      'OLD_GITHUB_CONTROL_NETWORK_PRESENT', 'OLD_GITHUB_CONTROL_NETWORK_ID',
      'OLD_GITHUB_EGRESS_NETWORK_PRESENT', 'OLD_GITHUB_EGRESS_NETWORK_ID',
    ]) expect(script).toContain(key);
    expect(script).toContain('[[ "$OLD_GITHUB_CONTROL_NETWORK_PRESENT" == 0 ]] && docker network inspect quarangate-github-control');
    expect(script).toContain('[[ "$OLD_GITHUB_EGRESS_NETWORK_PRESENT" == 0 ]] && docker network inspect quarangate-github-egress');
    expect(script).toContain('rollback_github_control_network_id');
    expect(script).toContain('rollback_github_egress_network_id');
  });

  it('accepts an explicit exact-current npm bundle only after verification and persists it atomically', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain('QUARANGATE_DEPLOY_NPM_BUNDLE_PATH');
    expect(script).toContain('scripts/npm-offline-bundle.mjs');
    expect(script).toContain("'QUARANGATE_NPM_BUNDLE_PATH': sys.argv[8]");
    expect(script).toContain("fail 'candidate npm bundle does not verify against exact source'");
  });

  it('generates a missing Docker-authority token independently and persists it without argv disclosure', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain("DOCKER_AUTHORITY_TOKEN_VALUE=\"$(python3 - <<'PYTOKEN'");
    expect(script).toContain('secrets.token_urlsafe(32)');
    expect(script).toContain('authority tokens must be distinct');
    expect(script).toContain("'DOCKER_AUTHORITY_TOKEN': os.environ['DOCKER_AUTHORITY_TOKEN']");
    expect(script).not.toContain("\"$DOCKER_AUTHORITY_TOKEN_VALUE\" <<'PY'");
  });

  it('refuses an existing Docker-authority without a persisted token instead of inventing an unrecoverable rollback secret', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain('existing Docker-authority requires a persisted DOCKER_AUTHORITY_TOKEN for exact rollback');
    expect(script).toContain('[[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 0 ]]');
  });

  it('arms runtime-env rollback before atomic persistence starts', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    const persistMarker = script.indexOf("=== PERSIST IMMUTABLE RUNTIME IMAGE IDENTITIES ===");
    const armed = script.indexOf('env_updated=1', persistMarker);
    const pythonWrite = script.indexOf('python3 - "$RUNTIME_ENV"', persistMarker);
    expect(persistMarker).toBeGreaterThanOrEqual(0);
    expect(armed).toBeGreaterThan(persistMarker);
    expect(pythonWrite).toBeGreaterThan(armed);
    expect(script.slice(pythonWrite)).not.toContain("PY\nenv_updated=1\n");
  });

  it('migrates a legacy Ollama tag only through the exact local RepoDigest for the same image ID', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain('tag-to-digest O1 migration requires exactly one historical Ollama container');
    expect(script).toContain("'{{range .RepoDigests}}{{println .}}{{end}}'");
    expect(script).toContain('historical Ollama image must expose exactly one repository digest');
    expect(script).toContain('derived Ollama repository digest does not preserve image identity');
    expect(script).toContain("updates['OLLAMA_IMAGE'] = os.environ['CANDIDATE_OLLAMA_IMAGE']");
  });

  it('allows GitHub rollback overlay fallback when the legacy operator root predates that tracked overlay', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain('github_rollback_overlay="$MAIN_ROOT/compose.github.yaml"');
    expect(script).toContain('github_rollback_overlay="$REPO_ROOT/compose.github.yaml"');
    expect(script).toContain('BASE_QG_FILES+=(-f "$github_rollback_overlay")');
  });

  it('preflights and exports the exact file-backed Kiro secret source before Compose deployment', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(script).toContain('read_runtime_value AGENT_KIRO_KEY_FILE');
    expect(script).toContain('scripts/resolve-kiro-key-file.mjs\" --verify');
    expect(script).toContain('Kiro API key host file metadata preflight failed');
    expect(script).toContain('export AGENT_KIRO_KEY_FILE=\"$KIRO_KEY_FILE\"');
  });

  it('candidate deployment builds candidate source but mounts validated live runtime config from the operator root', () => {
    const deploy = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    expect(deploy).toContain('--source-root "$REPO_ROOT"');
    expect(deploy).toContain('--source-commit "$REV"');
    expect(deploy).toContain('QG_FILES=(-f "$MAIN_ROOT/compose.yaml")');
    expect(deploy).toContain('-f "$root/config/clients.yaml"');
    expect(deploy).toContain('-f "$root/config/bridge.yaml"');
    expect(deploy).toContain('runtime_root_complete "$MAIN_ROOT"');
  });

  it('persists and verifies exact service tags plus immutable image IDs and verifies rollback by ID', () => {
    const deploy = readFileSync(join(root, 'scripts', 'remote-owner-deploy-candidate.sh'), 'utf8');
    for (const key of [
      'GATEWAY_IMAGE', 'GATEWAY_IMAGE_ID',
      'DOCKER_AUTHORITY_IMAGE', 'DOCKER_AUTHORITY_IMAGE_ID',
      'EXECUTOR_IMAGE', 'EXECUTOR_IMAGE_ID',
    ]) expect(deploy).toContain(`'${key}'`);
    expect(deploy).toContain('GATEWAY_IMAGE="$NEW_GATEWAY_IMAGE" DOCKER_AUTHORITY_IMAGE="$NEW_DOCKER_AUTHORITY_IMAGE" EXECUTOR_IMAGE="$NEW_EXECUTOR_IMAGE"');
    expect(deploy).toContain('persisted image tag was retargeted before deployment commit');
    expect(deploy).toContain('REMOTE_OWNER_ROLLBACK=PASS');
    expect(deploy).toContain('rollback_gateway_image_id');
    expect(deploy).toContain('rollback_authority_image_id');
    expect(deploy).toContain('rollback_executor_image_id');
  });

  it('unattended recovery refuses a retargeted primary tag and starts by exact immutable IDs', () => {
    const start = readFileSync(join(root, 'scripts', 'remote-owner-start.sh'), 'utf8');
    for (const key of ['GATEWAY_IMAGE_ID', 'DOCKER_AUTHORITY_IMAGE_ID', 'EXECUTOR_IMAGE_ID']) {
      expect(start).toContain(key);
    }
    expect(start).toContain('runtime image tag-to-ID binding mismatch');
    expect(start).toContain('export GATEWAY_IMAGE="$GATEWAY_IMAGE_ID" DOCKER_AUTHORITY_IMAGE="$DOCKER_AUTHORITY_IMAGE_ID" EXECUTOR_IMAGE="$EXECUTOR_IMAGE_ID"');
    expect(start).toContain('live image identity mismatch');
    expect(start).toContain('OLLAMA_IMAGE must be digest-pinned with @sha256');
  });

  it('live infra acceptance enforces docker-authority as the sole Docker socket holder', () => {
    const infra = readFileSync(join(root, 'scripts', 'remote-owner-infra-acceptance.sh'), 'utf8');
    expect(infra).toContain("[[ -n \"$authority_id\" ]] || fail 'docker-authority container missing'");
    expect(infra).toContain("docker-authority Docker socket missing");
    expect(infra).toContain("executor has Docker socket");
    expect(infra).toContain("gateway has Docker socket");
    expect(infra).toContain("projects-work has Docker socket");
    expect(infra).toContain('pass DOCKER_AUTHORITY_ONLY_DOCKER_SOCKET');
    expect(infra).not.toContain('pass EXECUTOR_ONLY_DOCKER_SOCKET');
  });
  it('linked-worktree recovery resolves the operator runtime root before composing QuaranGate', () => {
    for (const name of ['remote-owner-start.sh', 'remote-owner-health.sh']) {
      const script = readFileSync(join(root, 'scripts', name), 'utf8');
      expect(script, name).toContain('RUNTIME_ROOT="$REPO_ROOT"');
      expect(script, name).toContain('$RUNTIME_ROOT/config/clients.yaml');
      expect(script, name).toContain('QG_FILES=(-f "$RUNTIME_ROOT/compose.yaml")');
    }
    const infra = readFileSync(join(root, 'scripts', 'remote-owner-infra-acceptance.sh'), 'utf8');
    expect(infra).toContain('RUNTIME_ROOT="${QUARANGATE_RUNTIME_ROOT:-$REPO_ROOT}"');
    expect(infra).toContain('$RUNTIME_ROOT/config/clients.yaml');
    expect(infra).toContain('QG_FILES=(-f "$RUNTIME_ROOT/compose.yaml")');
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
