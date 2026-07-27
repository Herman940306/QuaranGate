#!/usr/bin/env node
// Validate config/bridge.yaml and config/clients.yaml without starting services.
import fs from 'node:fs';
import YAML from 'yaml';

let errors = 0;
const fail = (m) => { console.error('  ✗', m); errors++; };
const ok = (m) => console.log('  ✓', m);

function checkClients(path) {
  console.log('clients:', path);
  if (!fs.existsSync(path)) return fail('file missing');
  const doc = YAML.parse(fs.readFileSync(path, 'utf8'));
  const ids = new Set();
  const validScopes = new Set(['targets:read','files:read','files:write','files:delete','terminal:exec','git:read','process:read']);
  for (const c of doc.clients ?? []) {
    if (!c.id) fail('client missing id');
    if (ids.has(c.id)) fail(`duplicate client id ${c.id}`); else ids.add(c.id);
    if (!c.keyHash || /^<.*>$/.test(c.keyHash)) fail(`client ${c.id}: keyHash not set (run gen-key)`);
    else if (!/^[0-9a-f]{64}$/.test(c.keyHash)) fail(`client ${c.id}: keyHash is not a sha256 hex`);
    for (const s of c.scopes ?? []) if (!validScopes.has(s)) fail(`client ${c.id}: unknown scope ${s}`);
    if (!Array.isArray(c.targets)) fail(`client ${c.id}: targets must be a list`);
  }
  if (!errors) ok(`${(doc.clients ?? []).length} client(s) valid`);
}

function checkBridge(path) {
  console.log('targets:', path);
  if (!fs.existsSync(path)) return fail('file missing');
  const doc = YAML.parse(fs.readFileSync(path, 'utf8'));
  const ids = new Set();
  for (const t of doc.targets ?? []) {
    if (!t.id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.id)) fail(`invalid target id ${JSON.stringify(t.id)}`);
    if (ids.has(t.id)) fail(`duplicate target id ${t.id}`); else ids.add(t.id);
    if (!t.workspace || !t.workspace.startsWith('/')) fail(`target ${t.id}: workspace must be absolute`);
    if (!t.containerName && !(t.composeProject && t.composeService)) fail(`target ${t.id}: needs composeProject+composeService or containerName`);
  }
  if (!errors) ok(`${(doc.targets ?? []).length} target(s) valid`);
}

checkClients(process.env.CLIENTS_CONFIG ?? 'config/clients.yaml');
checkBridge(process.env.BRIDGE_CONFIG ?? 'config/bridge.yaml');
process.exit(errors ? 1 : 0);
