#!/usr/bin/env node
/**
 * N1D host secret-path resolution (MCP_IDE_BRIDGE_MASTER_PRD.md §47.8,
 * §47.13 DECISION-4 Option B).
 *
 * Prints the host path that should back the `kiro_api_key` Compose secret.
 * Compose's `${VAR:-default}` cannot express "use the new path, else the legacy
 * path", so that precedence lives here and is applied at deploy time:
 *
 *   1. AGENT_KIRO_KEY_FILE set and non-empty  → always wins (unchanged behavior)
 *   2. new QuaranGate path exists             → new path
 *   3. legacy path exists                     → legacy path (compatibility)
 *   4. neither exists                         → new path (so the failure names
 *                                               the path the operator should
 *                                               create, not the obsolete one)
 *
 * "New path first" is deliberate: after a migration the new path is the single
 * source of truth, and preferring it prevents silently picking up a stale key
 * left behind by a manual copy.
 *
 * This script only ever handles PATHS. It never opens, reads, prints, hashes or
 * copies the credential itself.
 *
 * Usage:
 *   AGENT_KIRO_KEY_FILE=$(node scripts/resolve-kiro-key-file.mjs) docker compose up -d
 *   node scripts/resolve-kiro-key-file.mjs --explain    # path + which rule fired
 */
import fs from 'node:fs';

export const QUARANGATE_KIRO_KEY_FILE = '/home/herman/.config/quarangate/kiro-api-key';
export const LEGACY_KIRO_KEY_FILE = '/home/herman/.config/mcp-ide-bridge/kiro-api-key';

/**
 * @param {{ env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean }} [deps]
 * @returns {{ path: string, source: 'explicit' | 'quarangate' | 'legacy' | 'default' }}
 */
export function resolveKiroKeyFile(deps = {}) {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? ((p) => fs.existsSync(p));

  const explicit = env.AGENT_KIRO_KEY_FILE;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return { path: explicit, source: 'explicit' };
  }
  if (exists(QUARANGATE_KIRO_KEY_FILE)) {
    return { path: QUARANGATE_KIRO_KEY_FILE, source: 'quarangate' };
  }
  if (exists(LEGACY_KIRO_KEY_FILE)) {
    return { path: LEGACY_KIRO_KEY_FILE, source: 'legacy' };
  }
  return { path: QUARANGATE_KIRO_KEY_FILE, source: 'default' };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const { path, source } = resolveKiroKeyFile();
  if (process.argv.includes('--explain')) {
    process.stdout.write(`${path}\t(${source})\n`);
  } else {
    process.stdout.write(`${path}\n`);
  }
}
