#!/usr/bin/env node
// Generate a client API key. Prints the key ONCE (store it in the client's
// config), and prints the sha256 hash to place in config/clients.yaml.
import { createHash, randomBytes } from 'node:crypto';

const clientId = process.argv[2];
if (!clientId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(clientId)) {
  console.error('usage: npm run gen-key -- <client-id>   (lowercase, [a-z0-9_-])');
  process.exit(1);
}
const key = `mcpb_${clientId}_${randomBytes(32).toString('base64url')}`;
const hash = createHash('sha256').update(key).digest('hex');

console.log('\nClient:', clientId);
console.log('API key (store securely, shown once):');
console.log('  ' + key);
console.log('\nkeyHash for config/clients.yaml:');
console.log('  keyHash: "' + hash + '"');
console.log('\nUse the key as a Bearer token or X-API-Key header from the MCP client.\n');
