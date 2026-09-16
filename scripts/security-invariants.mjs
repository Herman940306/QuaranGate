#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const failures = [];
const fail = (rule, path, detail) => failures.push({ rule, path, detail });
const text = (p) => readFileSync(join(root, p), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules' || name === '.git') continue;
    const rel = join(dir, name);
    const st = statSync(join(root, rel));
    if (st.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}

const compose = text('compose.yaml');
const serviceBlock = (name) => {
  const m = compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|^networks:|^volumes:|^secrets:|\\Z)`, 'm'));
  return m?.[0] ?? '';
};
const gateway = serviceBlock('gateway');
const executor = serviceBlock('executor');
const broker = serviceBlock('docker-authority');

if (!gateway) fail('COMPOSE_GATEWAY_PRESENT', 'compose.yaml', 'gateway service missing');
if (!executor) fail('COMPOSE_EXECUTOR_PRESENT', 'compose.yaml', 'executor service missing');
if (!broker) fail('COMPOSE_DOCKER_AUTHORITY_PRESENT', 'compose.yaml', 'docker-authority service missing');
for (const [name, block] of [['gateway', gateway], ['executor', executor]]) {
  if (/docker\.sock|DOCKER_SOCK|group_add\s*:/i.test(block)) fail('NO_RAW_DOCKER_AUTHORITY', 'compose.yaml', `${name} carries Docker socket/group authority`);
  if (/privileged\s*:\s*true/i.test(block)) fail('NO_PRIVILEGED_SERVICE', 'compose.yaml', `${name} is privileged`);
}
if (/^\s+ports\s*:/m.test(executor)) fail('EXECUTOR_NOT_PUBLISHED', 'compose.yaml', 'executor publishes host ports');
if (!/docker\.sock/i.test(broker)) fail('BROKER_IS_SOLE_DOCKER_HOLDER', 'compose.yaml', 'docker-authority broker does not declare Docker socket');
if (/^\s+ports\s*:/m.test(broker)) fail('BROKER_NOT_PUBLISHED', 'compose.yaml', 'docker-authority publishes host ports');

for (const p of walk('src')) {
  if (!/\.(?:ts|js|mjs|cjs)$/.test(p)) continue;
  const s = text(p);
  if (/privileged\s*:\s*true/i.test(s)) fail('NO_PRIVILEGED_RUNTIME_REQUEST', p, 'literal privileged:true found');
  if (/networkMode\s*:\s*['"]host['"]/i.test(s) || /NetworkMode\s*:\s*['"]host['"]/i.test(s)) fail('NO_HOST_NETWORK_REQUEST', p, 'literal host network request found');
  if ((p.startsWith('src/gateway/') || p.startsWith('runner/')) && /\/var\/run\/docker\.sock|DOCKER_SOCK/.test(s)) fail('DOCKER_SOCKET_FORBIDDEN_ZONE', p, 'raw Docker socket reference in gateway/runner authority zone');
}

const result = { ok: failures.length === 0, rulesChecked: 8, failures };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length) process.exit(1);
