import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { audit, resetAuditActivityForTests } from '../../src/gateway/audit.js';
import { KiroBackend } from '../../src/executor/agents/kiroBackend.js';

function captureAuditLines(fn: () => void): Array<Record<string, unknown>> {
  let captured = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write);
  try { fn(); } finally { spy.mockRestore(); }
  return captured.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function canonicalScalars(input: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))));
}

function expectedHash(record: Record<string, unknown>): string {
  const { entryHash: _entryHash, ...bound } = record;
  return createHash('sha256').update(Buffer.from(canonicalScalars(bound), 'utf8')).digest('hex');
}

afterEach(() => vi.restoreAllMocks());

describe('SH-15 operational security', () => {
  it('emits an ordered SHA-256 integrity chain for the gateway stdout audit stream', () => {
    resetAuditActivityForTests();
    const rows = captureAuditLines(() => {
      audit({ reqId: 'sh15-1', principal: 'owner', tool: 'fs_read', target: 'demo', decision: 'allow', durationMs: 4 });
      audit({ reqId: 'sh15-2', principal: 'owner', tool: 'terminal_exec', target: 'demo', decision: 'deny', code: 'FORBIDDEN_SCOPE', detail: 'token=synthetic-secret' });
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ auditVersion: 1, sequence: 1, previousHash: null });
    expect(rows[1]).toMatchObject({ auditVersion: 1, sequence: 2, previousHash: rows[0]!.entryHash });
    expect(rows[0]!.streamId).toEqual(rows[1]!.streamId);
    expect(rows[0]!.streamId).toEqual(expect.any(String));
    expect(rows[0]!.entryHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows[1]!.entryHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows[0]!.entryHash).toBe(expectedHash(rows[0]!));
    expect(rows[1]!.entryHash).toBe(expectedHash(rows[1]!));
    expect(JSON.stringify(rows)).not.toContain('synthetic-secret');
  });

  it('does not report Kiro cleanup complete when secret revocation is unverified', async () => {
    const credentialManager = {
      revokeSecret: vi.fn().mockRejectedValue(new Error('sensitive daemon detail')),
    };
    const backend = new KiroBackend({
      jobId: `job_${'f'.repeat(32)}`,
      principalId: 'owner',
      backend: 'kiro',
      project: 'p',
      profile: 'audit',
      prompt: 'x',
      hostPath: '/tmp/p',
      policy: {
        id: 'economy', modelClass: 'fast', maxRuntimeMs: 10_000, maxCpuMillicores: 1000,
        maxMemoryBytes: 256 * 1024 * 1024, maxPids: 64, maxOutputBytes: 65_536,
        maxEvidenceBytes: 1_048_576, networkPolicy: 'backend-only', retentionClass: 'ephemeral',
      },
      model: 'claude-sonnet-4',
    } as any, {
      runnerImage: 'runner:test', helperImage: 'helper:test', proxyImage: 'proxy:test', proxyCmd: ['node'],
      credentialManager,
      sandbox: {},
    } as any);
    (backend as any).secretVolume = 'io-quarangate-secret-job-test';

    await expect(backend.cleanup()).rejects.toMatchObject({ code: 'SANDBOX_FAILED' });
    expect(credentialManager.revokeSecret).toHaveBeenCalledTimes(1);
    expect((backend as any).secretVolume).toBe('io-quarangate-secret-job-test');
  });

  it('keeps the enterprise operational-security contract complete and honest about external gates', () => {
    const operational = readFileSync('docs/security/OPERATIONAL_SECURITY.md', 'utf8');
    const requiredSections = [
      'Secure defaults', 'Operational secrets', 'Rotation and revocation',
      'Audit integrity and retention', 'Backup and restore boundaries',
      'Recovery and service lifecycle', 'Incident handling', 'Least privilege',
      'Deployment and runbook truth', 'Known limitations and external gates',
      'Enterprise operating assumptions', 'Release evidence requirements',
    ];
    for (const heading of requiredSections) expect(operational).toContain(heading);
    expect(operational).toContain('SH-14 genuine independent external pentest execution/retest is external and is not self-certified');
    expect(operational).toContain('SH-03 MCP SDK/protocol migration remains dependent');
    expect(operational).toContain('SH-04 owner selection is CLOSED: Microsoft Entra ID is the first enterprise IdP profile');
    const sh04 = readFileSync('docs/audits/SH04_ENTERPRISE_IDP_SELECTION.md', 'utf8');
    expect(sh04).toContain('SH04_IDP_SELECTION=MICROSOFT_ENTRA_ID / GENERIC_OIDC_CONTRACT');
    expect(sh04).toContain('IMPLEMENTATION_NOT_STARTED / LIVE_QUALIFICATION_NOT_RUN');
    expect(sh04).toContain('IdP roles, groups, email addresses, display names, tenant roles, directory roles, or arbitrary token claims must **not** automatically become QuaranGate permissions');
    expect(operational).toContain('append-only/immutable collector');
    expect(operational).toContain('DOCKER_AUTHORITY_TOKEN');
    expect(operational).toContain('must be independently generated');
  });

  it('defines an incident process that preserves evidence and never self-closes an external retest', () => {
    const incident = readFileSync('docs/operations/INCIDENT_RESPONSE.md', 'utf8');
    for (const section of [
      'Declare and scope the incident', 'Contain without destroying evidence', 'Preserve evidence',
      'Revoke and rotate affected credentials', 'Investigate exact authority and integrity',
      'Remediate in an isolated writer lane', 'Recover service', 'External findings', 'Exit criteria',
    ]) expect(incident).toContain(section);
    expect(incident).toContain('must not be represented as the external retest');
    expect(incident).toContain('uncertainty into PASS');
  });

  it('keeps current operator guidance aligned to broker-only raw Docker authority', () => {
    const currentGuides = [
      'README.md',
      'docs/security/SECURITY.md',
      'docs/operations/OPERATIONS.md',
      'docs/operations/REMOTE_OWNER_ORCHESTRATION.md',
      'docs/architecture/ARCHITECTURE.md',
      'docs/user-guides/CLIENT_SETUP.md',
    ];
    const combined = currentGuides.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(combined).not.toMatch(/executor (?:holds|owns|remains the only normal QuaranGate service with) (?:the )?(?:raw )?Docker socket/iu);
    expect(combined).not.toContain('executor-only Docker socket ownership is preserved');
    expect(combined).toContain('Docker-authority');
    expect(combined).toContain('broker');
  });

  it('requires separate internal-service and Docker-authority credentials in production configuration', () => {
    const compose = readFileSync('compose.yaml', 'utf8');
    const env = readFileSync('.env.example', 'utf8');
    expect(compose.match(/DOCKER_AUTHORITY_TOKEN: "\$\{DOCKER_AUTHORITY_TOKEN:\?/gu)).toHaveLength(2);
    expect(compose).not.toContain('DOCKER_AUTHORITY_TOKEN: "${INTERNAL_TOKEN:');
    expect(env).toContain('DOCKER_AUTHORITY_TOKEN=<SET_DISTINCT_SECURELY>');
    expect(env).toContain('MUST NOT equal');
  });
});
