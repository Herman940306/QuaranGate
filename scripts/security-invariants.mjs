#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const root = resolve(rootAt >= 0 ? args[rootAt + 1] : '.');
const failures = [];
const fail = (rule, path, detail) => failures.push({ rule, path, detail });
const norm = (p) => p.split(sep).join('/');
const text = (p) => readFileSync(resolve(root, p), 'utf8');

function trackedFiles() {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (r.status === 0) return r.stdout.split(/\r?\n/).filter(Boolean).map(norm);
  throw new Error(`git ls-files failed: ${r.stderr || r.stdout}`);
}

const files = trackedFiles();
const composeFiles = files.filter((p) => /(^|\/)compose(?:\.[^/]+)?\.ya?ml$/i.test(p));
const dockerfiles = files.filter((p) => /(^|\/)Dockerfile(?:\.[^/]*)?$/i.test(p));
if (!composeFiles.includes('compose.yaml')) fail('PRIMARY_COMPOSE_PRESENT', 'compose.yaml', 'primary compose.yaml missing');

for (const p of composeFiles) {
  let doc;
  try { doc = YAML.parse(text(p)); } catch (e) { fail('COMPOSE_PARSE', p, String(e)); continue; }
  for (const [name, service] of Object.entries(doc?.services ?? {})) {
    const s = service ?? {};
    if (s.privileged === true) fail('NO_PRIVILEGED_SERVICE', p, `${name} is privileged`);
    if (s.network_mode === 'host') fail('NO_HOST_NETWORK_SERVICE', p, `${name} uses host network`);
    const volumes = Array.isArray(s.volumes) ? s.volumes : [];
    const hasDockerSock = volumes.some((v) => typeof v === 'string' ? /(?:^|:)\/var\/run\/docker\.sock(?::|$)/.test(v) : /\/var\/run\/docker\.sock/.test(String(v?.source ?? '')));
    const hasDockerGroup = Array.isArray(s.group_add) && s.group_add.length > 0;
    if ((name === 'gateway' || name === 'executor' || /runner/i.test(name)) && (hasDockerSock || hasDockerGroup)) {
      fail('NO_RAW_DOCKER_AUTHORITY', p, `${name} carries Docker socket/group authority`);
    }
    if (name === 'executor' && Array.isArray(s.ports) && s.ports.length) fail('EXECUTOR_NOT_PUBLISHED', p, 'executor publishes host ports');
    if (name === 'docker-authority') {
      if (!hasDockerSock) fail('BROKER_IS_DOCKER_HOLDER', p, 'docker-authority broker lacks Docker socket');
      if (Array.isArray(s.ports) && s.ports.length) fail('BROKER_NOT_PUBLISHED', p, 'docker-authority publishes host ports');
    }
  }
}

for (const p of dockerfiles) {
  const s = text(p);
  if (/^\s*USER\s+root\s*$/mi.test(s) && !/^\s*USER\s+(?!root\b)\S+/mi.test(s)) fail('NO_ROOT_FINAL_IMAGE_USER', p, 'Dockerfile never leaves root user');
}

for (const p of files.filter((p) => /^(?:src|runner)\/.*\.(?:ts|js|mjs|cjs)$/.test(p))) {
  const s = text(p);
  if (/privileged\s*:\s*true/i.test(s)) fail('NO_PRIVILEGED_RUNTIME_REQUEST', p, 'literal privileged:true found');
  if (/networkMode\s*:\s*['"]host['"]/i.test(s) || /NetworkMode\s*:\s*['"]host['"]/i.test(s)) fail('NO_HOST_NETWORK_REQUEST', p, 'literal host network request found');
  if ((p.startsWith('src/gateway/') || p.startsWith('runner/')) && /\/var\/run\/docker\.sock|DOCKER_SOCK/.test(s)) fail('DOCKER_SOCKET_FORBIDDEN_ZONE', p, 'raw Docker socket reference in gateway/runner authority zone');
  if (/HostConfig\s*:\s*(?:input|args|params|request|payload)\b/i.test(s)) fail('NO_CALLER_HOSTCONFIG', p, 'caller-controlled HostConfig assignment found');
  if (/\b(?:Binds|NetworkMode)\s*:\s*(?:input|args|params|request|payload)\b/i.test(s)) fail('NO_CALLER_DOCKER_AUTHORITY', p, 'caller-controlled Docker authority field found');
}

failures.sort((a,b) => `${a.rule}\0${a.path}\0${a.detail}`.localeCompare(`${b.rule}\0${b.path}\0${b.detail}`));
const result = { ok: failures.length === 0, rulesChecked: 12, composeFilesChecked: composeFiles.length, dockerfilesChecked: dockerfiles.length, failures };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length) process.exit(1);
