import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { scannerPlan, validateOfflinePrerequisites } from '../../scripts/release-scanner-run.mjs';

const owned: string[] = [];
afterEach(() => { while (owned.length) rmSync(owned.pop()!, { recursive: true, force: true }); });

describe('SH-05 fixed offline scanner invocation contract', () => {
  it('uses only the source-local Semgrep ruleset and disables telemetry/version lookup', () => {
    const plan = scannerPlan('sast');
    expect(plan.binary).toBe('semgrep');
    expect(plan.args).toEqual(['scan', '--config', 'security/semgrep.yml', '--json', '--error', '--metrics=off', '--disable-version-check', '--jobs', '1', '.']);
    expect(plan.args.join(' ')).not.toMatch(/config\s+auto|https?:\/\//u);
  });

  it('forces Gitleaks to redact secrets into a JSON report', () => {
    const plan = scannerPlan('secrets', { output: '/evidence/gitleaks.json' });
    expect(plan.args).toEqual(['dir', '--no-banner', '--no-color', '--redact=100', '--report-format', 'json', '--report-path', '/evidence/gitleaks.json', '.']);
  });

  it('requires an explicit OSV offline database and performs an offline-only source scan', () => {
    const root = mkdtempSync(join(tmpdir(), 'qg-osv-cache-')); owned.push(root);
    mkdirSync(join(root, 'osv-scanner', 'npm'), { recursive: true }); writeFileSync(join(root, 'osv-scanner', 'npm', 'all.zip'), 'fixture');
    const env = { ...process.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: root };
    expect(validateOfflinePrerequisites('sca', env)).toEqual([]);
    const plan = scannerPlan('sca', { env });
    expect(plan.args).toEqual(['scan', 'source', '--recursive', '--offline', '--offline-vulnerabilities', '--format', 'json', '.']);
    expect(plan.env).toEqual({ OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: root });
    expect(plan.args.join(' ')).not.toContain('download');
  });

  it('fails prerequisite classification when OSV or Trivy offline state is absent', () => {
    expect(validateOfflinePrerequisites('sca', { ...process.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: '' })).toEqual(['OSV_OFFLINE_DATABASE_UNAVAILABLE']);
    expect(validateOfflinePrerequisites('config-scan', { ...process.env, QG_TRIVY_CACHE_DIR: '' })).toEqual(['TRIVY_OFFLINE_CACHE_UNAVAILABLE']);
    expect(validateOfflinePrerequisites('image-scan', { ...process.env, QG_TRIVY_CACHE_DIR: '' })).toEqual(['TRIVY_OFFLINE_CACHE_UNAVAILABLE']);
  });

  it('runs Trivy config with update checks disabled against a pre-provisioned cache', () => {
    const cache = mkdtempSync(join(tmpdir(), 'qg-trivy-cache-')); owned.push(cache);
    const plan = scannerPlan('config-scan', { output: '/evidence/config.json', env: { ...process.env, QG_TRIVY_CACHE_DIR: cache } });
    expect(plan.args).toEqual(['--cache-dir', cache, 'config', '--skip-check-update', '--skip-version-check', '--format', 'json', '--exit-code', '1', '--output', '/evidence/config.json', '.']);
  });

  it('scans only exact local digest-bound images and disables remote/update paths', () => {
    const cache = mkdtempSync(join(tmpdir(), 'qg-trivy-image-cache-')); owned.push(cache);
    const digest = `sha256:${'a'.repeat(64)}`;
    const images = [{ component: 'gateway', reference: 'quarangate-gateway:git-deadbeef', digest }];
    const plan = scannerPlan('image-scan', { imageInputs: images, env: { ...process.env, QG_TRIVY_CACHE_DIR: cache } });
    expect(plan.batch).toHaveLength(1);
    expect(plan.batch![0].args).toEqual([
      '--cache-dir', cache, 'image', '--image-src', 'docker', '--offline-scan', '--skip-db-update', '--skip-java-db-update',
      '--skip-check-update', '--skip-version-check', '--skip-vex-repo-update', '--scanners', 'vuln,secret', '--image-config-scanners', 'misconfig,secret', '--format', 'json', '--exit-code', '1',
      `quarangate-gateway:git-deadbeef@${digest}`,
    ]);
    expect(plan.batch![0].args.join(' ')).not.toMatch(/\b(remote|pull|download)\b/u);
    expect(plan.batch![0].args).toEqual(expect.arrayContaining(['--scanners', 'vuln,secret', '--image-config-scanners', 'misconfig,secret']));
  });

  it('the committed Semgrep policy is valid local YAML with no registry/URL-backed rules', () => {
    const text = readFileSync('security/semgrep.yml', 'utf8');
    const policy = YAML.parse(text);
    expect(Array.isArray(policy?.rules)).toBe(true);
    expect(policy.rules.map((rule: any) => rule.id)).toEqual(expect.arrayContaining(['quarangate.no-eval', 'quarangate.no-shell-true', 'quarangate.no-child-process-exec', 'quarangate.no-node-tls-disable-env']));
    expect(policy.rules.every((rule: any) => (typeof rule.pattern === 'string' && rule.pattern.length > 0) || (Array.isArray(rule['pattern-either']) && rule['pattern-either'].length > 0))).toBe(true);
    expect(text).not.toMatch(/https?:\/\/|config:\s*(?:p\/|r\/)/u);
  });
});
