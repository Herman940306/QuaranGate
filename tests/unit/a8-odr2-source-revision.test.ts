import { describe, expect, it } from 'vitest';
import { AGENT_JOB_SCHEMA_VERSION, AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sessionPolicy from '../../src/executor/agents/sessionPolicy.js';
import { BridgeError } from '../../src/shared/errors.js';

const REV_A = 'a'.repeat(40);
const REV_B = 'b'.repeat(40);
const SESSION = 'sess_' + '1'.repeat(32);

function insertBoundSession(store: AgentJobStore, sourceRevision: string | null = REV_A): void {
  store.sessionStore.insertSession({
    sessionId: SESSION,
    principalId: 'alice',
    project: 'proj-a',
    backend: 'kiro',
    profile: 'implement',
    providerSessionId: 'provider-session',
    providerStateRef: 'provider-state',
    sourceRevision,
  } as Parameters<typeof store.sessionStore.insertSession>[0]);
}

describe('A8 ODR-2 source revision binding', () => {
  it('persists the trusted source revision on durable sessions', () => {
    const store = new AgentJobStore(':memory:');
    insertBoundSession(store);
    const row = store.sessionStore.getSession(SESSION) as unknown as { sourceRevision?: string | null };
    expect(row.sourceRevision).toBe(REV_A);
  });

  it('bumps the durable schema for additive session revision binding', () => {
    const store = new AgentJobStore(':memory:');
    expect(store.schemaVersion).toBe(AGENT_JOB_SCHEMA_VERSION);
  });


  it('migrates genuine v8 session rows to v9 without fabricating source provenance', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'qg-a8-odr2-v8-')), 'agents.db');
    const seeded = new AgentJobStore(dbPath);
    insertBoundSession(seeded);
    seeded.close();

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      DROP TABLE execution_resource_leases;
      ALTER TABLE agent_jobs DROP COLUMN global_exclusive;
      ALTER TABLE agent_jobs DROP COLUMN execution_resources;
      ALTER TABLE agent_sessions DROP COLUMN source_revision;
      PRAGMA user_version=8;
    `);
    legacy.close();

    const migrated = new AgentJobStore(dbPath);
    expect(migrated.schemaVersion).toBe(AGENT_JOB_SCHEMA_VERSION);
    expect(migrated.sessionStore.getSession(SESSION)!.sourceRevision).toBeNull();
    migrated.close();
  });

  it('rejects a v8 stamp that already contains partial v9 source-revision state', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'qg-a8-odr2-partial-')), 'agents.db');
    new AgentJobStore(dbPath).close();
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA user_version=8;');
    db.close();

    expect(() => new AgentJobStore(dbPath)).toThrow(/partial v9 session source-revision state/);
    const after = new DatabaseSync(dbPath);
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(8);
    expect((after.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[]).some((row) => row.name === 'source_revision')).toBe(true);
    after.close();
  });

  it('writer resume fails closed when freshly attested source drifted', () => {
    const enforce = (sessionPolicy as unknown as {
      enforceSessionSourceRevision?: (input: { writer: boolean; storedRevision: string | null; currentRevision: string }) => string;
    }).enforceSessionSourceRevision;
    expect(enforce).toBeTypeOf('function');
    expect(() => enforce!({ writer: true, storedRevision: REV_A, currentRevision: REV_B }))
      .toThrowError(expect.objectContaining({ code: 'SESSION_NOT_RESUMABLE' } satisfies Partial<BridgeError>));
  });

  it('read-only resume allows drift only as context-only continuity after fresh attestation', () => {
    const enforce = (sessionPolicy as unknown as {
      enforceSessionSourceRevision?: (input: { writer: boolean; storedRevision: string | null; currentRevision: string }) => string;
    }).enforceSessionSourceRevision;
    expect(enforce).toBeTypeOf('function');
    expect(enforce!({ writer: false, storedRevision: REV_A, currentRevision: REV_B }))
      .toBe('DRIFT_ALLOWED_CONTEXT_ONLY');
  });

  it('legacy unbound writer sessions fail closed, while read-only continuity may re-attest', () => {
    const enforce = (sessionPolicy as unknown as {
      enforceSessionSourceRevision?: (input: { writer: boolean; storedRevision: string | null; currentRevision: string }) => string;
    }).enforceSessionSourceRevision;
    expect(enforce).toBeTypeOf('function');
    expect(() => enforce!({ writer: true, storedRevision: null, currentRevision: REV_B }))
      .toThrowError(expect.objectContaining({ code: 'SESSION_NOT_RESUMABLE' } satisfies Partial<BridgeError>));
    expect(enforce!({ writer: false, storedRevision: null, currentRevision: REV_B }))
      .toBe('UNBOUND_ALLOWED_CONTEXT_ONLY');
  });
});
