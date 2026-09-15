import { describe, expect, it } from 'vitest';
import { parseIdeSessionConfigYaml, validateIdeSessionConfig } from '../../src/executor/ide/ideSessionConfig.js';

function valid() {
  return {
    version: 1 as const,
    enrollments: [{
      principalId: 'chatgpt-browser',
      projectId: 'quarangate',
      worktreeId: 'forward',
      ideProduct: 'vscode' as const,
      ideInstanceId: `ide_${'1'.repeat(32)}`,
      workspaceFingerprint: 'a'.repeat(64),
      baseRevision: 'b'.repeat(40),
      capabilities: ['prompt', 'cancel', 'observe_response', 'request_review'],
      adapterVersion: '0.1.0',
      runtimeInstanceId: `iderun_${'2'.repeat(32)}`,
    }],
  };
}

describe('P7 trusted IDE session config for VS Code and Cursor', () => {
  it('accepts only the explicit review-only enrollment shape', () => {
    const parsed = validateIdeSessionConfig(valid());
    expect(parsed.version).toBe(1);
    expect(parsed.enrollments).toHaveLength(1);
    expect(parsed.enrollments[0]!.capabilities).toEqual(['prompt', 'cancel', 'observe_response', 'request_review']);
  });

  it('accepts Cursor but rejects unknown keys, unsupported products and implementation authority', () => {
    expect(() => validateIdeSessionConfig({ ...valid(), extra: true })).toThrow(/unrecognized key/i);
    const cursor = valid();
    (cursor.enrollments[0] as unknown as Record<string, unknown>).ideProduct = 'cursor';
    expect(validateIdeSessionConfig(cursor).enrollments[0]!.ideProduct).toBe('cursor');
    const unsupported = valid();
    (unsupported.enrollments[0] as unknown as Record<string, unknown>).ideProduct = 'kiro';
    expect(() => validateIdeSessionConfig(unsupported)).toThrow();
    const implementation = valid(); implementation.enrollments[0]!.capabilities = ['request_review', 'request_implementation'];
    expect(() => validateIdeSessionConfig(implementation)).toThrow(/review-only base capability set/);
  });

  it('rejects duplicate bindings and duplicate durable runtime identities', () => {
    const duplicateBinding = valid(); duplicateBinding.enrollments.push({ ...duplicateBinding.enrollments[0]!, runtimeInstanceId: `iderun_${'3'.repeat(32)}` });
    expect(() => validateIdeSessionConfig(duplicateBinding)).toThrow(/duplicate enrollment binding/);
    const duplicateRuntime = valid(); duplicateRuntime.enrollments.push({
      ...duplicateRuntime.enrollments[0]!,
      ideInstanceId: `ide_${'4'.repeat(32)}`,
    });
    expect(() => validateIdeSessionConfig(duplicateRuntime)).toThrow(/duplicate runtimeInstanceId/);
  });

  it('rejects malformed identity, revision, adapter version and runtime identity', () => {
    for (const [field, value] of [
      ['principalId', 'bad principal!'],
      ['workspaceFingerprint', 'abc'],
      ['baseRevision', 'deadbeef'],
      ['adapterVersion', 'latest'],
      ['runtimeInstanceId', 'iderun_bad'],
    ] as const) {
      const cfg = valid();
      (cfg.enrollments[0] as unknown as Record<string, unknown>)[field] = value;
      expect(() => validateIdeSessionConfig(cfg)).toThrow();
    }
  });

  it('parses strict YAML without accepting ambient host paths', () => {
    const yaml = `version: 1\nenrollments:\n  - principalId: owner\n    projectId: project\n    worktreeId: forward\n    ideProduct: vscode\n    ideInstanceId: ide_${'1'.repeat(32)}\n    workspaceFingerprint: ${'a'.repeat(64)}\n    capabilities: [prompt, cancel, observe_response, request_review]\n    adapterVersion: 0.1.0\n    runtimeInstanceId: iderun_${'2'.repeat(32)}\n`;
    expect(parseIdeSessionConfigYaml(yaml).enrollments[0]).not.toHaveProperty('hostPath');
    expect(() => parseIdeSessionConfigYaml(`${yaml}    hostPath: /workspace\n`)).toThrow(/unrecognized key/i);
  });
});
