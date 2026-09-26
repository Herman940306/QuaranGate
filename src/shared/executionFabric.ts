/**
 * BE1A cross-project execution-fabric contracts.
 *
 * Resource identities are executor-owned logical identifiers. They are never
 * caller supplied host paths, Docker selectors, credentials, or provider
 * payloads. The trusted agent registry resolves which resources a project
 * requires before a job is persisted.
 */
export const EXECUTION_RESOURCE_CATEGORIES = [
  'worktree',
  'compose-project',
  'port',
  'database',
  'gpu',
  'provider-slot',
  'owner-host',
  'release-signing',
  'production-deployment',
  'shared-cache',
  'temp-root',
  'machine',
] as const;

export type ExecutionResourceCategory = (typeof EXECUTION_RESOURCE_CATEGORIES)[number];

/** Deliberately excludes slash/backslash/colon so an id cannot encode a path. */
export const EXECUTION_RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ExecutionResourceRef {
  category: ExecutionResourceCategory;
  id: string;
}

export const DEFAULT_AGENT_MAX_CONCURRENCY = 4;
export const MAX_AGENT_MAX_CONCURRENCY = 32;
export const DEFAULT_PROJECT_QUEUE_CAPACITY = 16;
export const MAX_PROJECT_QUEUE_CAPACITY = 64;

export function executionResourceKey(ref: ExecutionResourceRef): string {
  return `${ref.category}:${ref.id}`;
}

export function parseExecutionResourceKey(key: string): ExecutionResourceRef {
  const idx = key.indexOf(':');
  if (idx <= 0) throw new Error('malformed execution resource key');
  const category = key.slice(0, idx) as ExecutionResourceCategory;
  const id = key.slice(idx + 1);
  if (!(EXECUTION_RESOURCE_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error('unknown execution resource category');
  }
  if (!EXECUTION_RESOURCE_ID_PATTERN.test(id)) throw new Error('malformed execution resource id');
  return { category, id };
}
