import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerSecurityAssessmentTools } from '../../src/gateway/securityAssessmentTools.js';

interface CapturedTool {
  name: string;
  config: {
    inputSchema: { safeParse(value: unknown): { success: boolean } };
    annotations?: Record<string, unknown>;
  };
}

function capture(): CapturedTool[] {
  const tools: CapturedTool[] = [];
  registerSecurityAssessmentTools({
    registerTool(name: string, config: CapturedTool['config']) {
      tools.push({ name, config });
    },
  } as never);
  return tools;
}

describe('BE9.2 MCP assessment surface', () => {
  it('registers only the four frozen assessment capability classes', () => {
    expect(capture().map((tool) => tool.name)).toEqual([
      'security_assessment_start',
      'security_assessment_status',
      'security_assessment_cancel',
      'security_assessment_evidence',
    ]);
  });

  it('keeps start input to exact discovery identity and rejects caller-shaped authority', () => {
    const start = capture().find((tool) => tool.name === 'security_assessment_start');
    if (!start) throw new Error('missing_start_tool');
    const discoveryId = `disc_${'a'.repeat(24)}`;
    expect(start.config.inputSchema.safeParse({ discoveryId }).success).toBe(true);
    for (const extra of [
      { organizationId: 'org-a' },
      { workspaceId: 'ws-a' },
      { principalRef: 'principal-a' },
      { sourceRevision: 'b'.repeat(40) },
      { hostPath: '/workspace' },
      { scanner: 'semgrep' },
      { image: 'attacker:latest' },
      { argv: ['sh', '-c', 'id'] },
      { network: 'internet' },
      { credential: 'secret' },
    ]) {
      expect(start.config.inputSchema.safeParse({ discoveryId, ...extra }).success).toBe(false);
    }
  });

  it('keeps status/cancel/evidence input to assessmentId only', () => {
    const assessmentId = `assessment_${'c'.repeat(24)}`;
    for (const name of [
      'security_assessment_status',
      'security_assessment_cancel',
      'security_assessment_evidence',
    ]) {
      const tool = capture().find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`missing_${name}`);
      expect(tool.config.inputSchema.safeParse({ assessmentId }).success).toBe(true);
      expect(tool.config.inputSchema.safeParse({ assessmentId, workspaceId: 'ws-a' }).success).toBe(false);
      expect(tool.config.inputSchema.safeParse({ assessmentId, target: 'demo' }).success).toBe(false);
    }
  });

  it('marks read operations non-destructive and cancellation explicitly destructive', () => {
    const tools = new Map(capture().map((tool) => [tool.name, tool]));
    expect(tools.get('security_assessment_status')?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.get('security_assessment_evidence')?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.get('security_assessment_cancel')?.config.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it('is mounted into the normal MCP server without generic execution shortcuts', () => {
    const mcp = readFileSync(join(process.cwd(), 'src/gateway/mcp.ts'), 'utf8');
    const source = readFileSync(join(process.cwd(), 'src/gateway/securityAssessmentTools.ts'), 'utf8');
    expect(mcp).toContain('registerSecurityAssessmentTools(server)');
    expect(source).toContain('productAssessmentClient.startIntent');
    expect(source).toContain('admission.admitResolvedPrincipal');
    expect(source).toContain('productAssessmentClient.applyAdmission');
    expect(source).not.toMatch(/terminal_exec|agent_dispatch|execManaged|raw Docker|docker socket/i);
  });
});
