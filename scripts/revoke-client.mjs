#!/usr/bin/env node
// Revoke a client by disabling it (or removing it) in config/clients.yaml.
// Rotation = generate a new key (gen-client-key) and replace keyHash.
import fs from 'node:fs';
import YAML from 'yaml';

const [, , clientId, mode] = process.argv;
const path = process.env.CLIENTS_CONFIG ?? 'config/clients.yaml';
if (!clientId) {
  console.error('usage: npm run revoke-key -- <client-id> [--remove]');
  process.exit(1);
}
if (!fs.existsSync(path)) { console.error('no config at', path); process.exit(1); }
const doc = YAML.parse(fs.readFileSync(path, 'utf8'));
const before = doc.clients?.length ?? 0;
if (mode === '--remove') {
  doc.clients = (doc.clients ?? []).filter((c) => c.id !== clientId);
  if ((doc.clients.length) === before) { console.error('client not found:', clientId); process.exit(1); }
  console.log('removed', clientId);
} else {
  const c = (doc.clients ?? []).find((c) => c.id === clientId);
  if (!c) { console.error('client not found:', clientId); process.exit(1); }
  c.enabled = false;
  console.log('disabled', clientId, '(tokens/keys now rejected). Re-enable by setting enabled: true.');
}
fs.writeFileSync(path, YAML.stringify(doc));
console.log('Reload the executor/gateway config for changes to take effect.');
