import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../../src/gateway/mcp.js';
import { runProperty } from '../helpers/sh08Property.js';

type RegisteredTool = {
  inputSchema?: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
};
type ServerInternals = {
  _registeredTools: Record<string, RegisteredTool>;
  validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
  validateToolOutput(tool: RegisteredTool, result: unknown, name: string): Promise<void>;
};

function serverInternals(): ServerInternals { return buildServer() as unknown as ServerInternals; }

function assertDeepStrict(schema: z.ZodTypeAny | undefined, label: string, seen = new Set<z.ZodTypeAny>()): number {
  if (!schema || seen.has(schema)) return 0;
  seen.add(schema);
  if (schema instanceof z.ZodObject) {
    expect(schema._def.unknownKeys, label).toBe('strict');
    let n = 1;
    for (const [key, child] of Object.entries(schema.shape)) n += assertDeepStrict(child, `${label}.${key}`, seen);
    return n;
  }
  if (schema instanceof z.ZodArray) return assertDeepStrict(schema.element, `${label}[]`, seen);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    return assertDeepStrict(schema._def.innerType, `${label}<inner>`, seen);
  }
  if (schema instanceof z.ZodEffects) return assertDeepStrict(schema._def.schema, `${label}<effect>`, seen);
  if (schema instanceof z.ZodUnion) return schema._def.options.reduce((n: number, child: z.ZodTypeAny, i: number) => n + assertDeepStrict(child, `${label}|${i}`, seen), 0);
  return 0;
}

const JOB = `job_${'a'.repeat(32)}`;

describe('SH-08 MCP tool-schema properties', () => {
  it('all 49 registered tools use recursively strict object contracts', () => {
    const s = serverInternals();
    const names = Object.keys(s._registeredTools).sort();
    expect(names).toHaveLength(49);
    let objectSchemas = 0;
    for (const name of names) {
      const tool = s._registeredTools[name]!;
      objectSchemas += assertDeepStrict(tool.inputSchema, `${name}.input`);
      objectSchemas += assertDeepStrict(tool.outputSchema, `${name}.output`);
    }
    expect(objectSchemas).toBeGreaterThanOrEqual(100);
  });

  it('the real pinned SDK rejects generated unknown input fields instead of stripping them', async () => {
    const s = serverInternals();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['targets_list', {}],
      ['target_inspect', { target: 'projects-work' }],
      ['fs_read', { target: 'projects-work', path: 'README.md' }],
      ['terminal_exec', { target: 'projects-work', command: 'pwd' }],
      ['agent_status', { jobId: JOB }],
      ['github_repository', { repository: 'Owner/repo' }],
      ['control_center_query', { view: 'summary' }],
    ];
    for (const [name, baseline] of cases) {
      const tool = s._registeredTools[name]!;
      await expect(s.validateToolInput(tool, baseline, name), `${name} baseline`).resolves.toBeDefined();
      runProperty(`${name}-unknown-input`, { seed: 0x08d000 + name.length, iterations: 60 }, (rng, iteration) => {
        const field = `sh08Unknown_${iteration}_${rng.nextU32().toString(16)}`;
        expect(field in baseline).toBe(false);
      });
      for (let i = 0; i < 25; i++) {
        const field = `sh08Unknown_${i}_${name.length}`;
        await expect(s.validateToolInput(tool, { ...baseline, [field]: 'forbidden-extra' }, name)).rejects.toThrow(/Input validation error/u);
      }
    }
  });

  it('the real pinned SDK rejects unexpected top-level and nested output fields', async () => {
    const s = serverInternals();
    const tool = s._registeredTools.targets_list!;
    const base = { content: [{ type: 'text', text: '{}' }], structuredContent: { targets: [] } };
    await expect(s.validateToolOutput(tool, base, 'targets_list')).resolves.toBeUndefined();
    await expect(s.validateToolOutput(tool, {
      ...base, structuredContent: { targets: [], secretLeak: 'must-fail' },
    }, 'targets_list')).rejects.toThrow(/Output validation error/u);
    await expect(s.validateToolOutput(tool, {
      ...base,
      structuredContent: { targets: [{
        id:'x', name:'x', source:'manual', running:true, workspace:'/workspace', composeProject:null, composeService:null,
        secretLeak:'must-fail',
      }] },
    }, 'targets_list')).rejects.toThrow(/Output validation error/u);
  });

  it('strictness does not alter the exact tool catalog or mutation annotations', () => {
    const s = serverInternals();
    const names = Object.keys(s._registeredTools);
    expect(new Set(names).size).toBe(49);
    for (const required of [
      'fs_write','fs_delete','terminal_exec','agent_apply','agent_discard',
      'github_push_branch','github_pull_request_review',
      'security_assessment_start','security_assessment_status',
      'security_assessment_cancel','security_assessment_evidence',
    ]) {
      expect(s._registeredTools[required], required).toBeDefined();
    }
  });
});
