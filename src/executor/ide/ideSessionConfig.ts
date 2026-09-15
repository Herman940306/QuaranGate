/**
 * Trusted Plane-B IDE Session Control enrollment configuration.
 *
 * This registry is deliberately separate from agents.yaml. It contains only
 * explicit logical enrollment identity plus one durable QuaranGate runtime
 * instance identity. It never accepts host workspace paths, public/MCP input,
 * provider credentials, or implementation authority.
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { BridgeError } from '../../shared/errors.js';
import {
  IDE_CAPABILITIES,
  IDE_GIT_REVISION_PATTERN,
  IDE_INSTANCE_ID_PATTERN,
  IDE_LOGICAL_ID_PATTERN,
  IDE_PRINCIPAL_ID_PATTERN,
  IDE_REVIEW_BASE_CAPABILITIES,
  IDE_WORKSPACE_FINGERPRINT_PATTERN,
  type IdeCapability,
} from '../../shared/ideSessions.js';
import {
  IDE_COMPANION_ADAPTER_VERSION_PATTERN,
  IDE_COMPANION_RUNTIME_INSTANCE_PATTERN,
} from './ideCompanionRuntime.js';

export const IDE_SESSION_CONFIG_VERSION = 1 as const;
export const IDE_SESSION_CONFIG_MAX_ENROLLMENTS = 16;

const capability = z.enum(IDE_CAPABILITIES);
const enrollmentSchema = z.object({
  principalId: z.string().regex(IDE_PRINCIPAL_ID_PATTERN),
  projectId: z.string().regex(IDE_LOGICAL_ID_PATTERN),
  worktreeId: z.string().regex(IDE_LOGICAL_ID_PATTERN),
  ideProduct: z.enum(['vscode', 'cursor']),
  ideInstanceId: z.string().regex(IDE_INSTANCE_ID_PATTERN),
  workspaceFingerprint: z.string().regex(IDE_WORKSPACE_FINGERPRINT_PATTERN),
  baseRevision: z.string().regex(IDE_GIT_REVISION_PATTERN).optional(),
  capabilities: z.array(capability).min(1).max(IDE_CAPABILITIES.length),
  adapterVersion: z.string().min(1).max(64).regex(IDE_COMPANION_ADAPTER_VERSION_PATTERN),
  runtimeInstanceId: z.string().regex(IDE_COMPANION_RUNTIME_INSTANCE_PATTERN),
}).strict();

const configSchema = z.object({
  version: z.literal(IDE_SESSION_CONFIG_VERSION),
  enrollments: z.array(enrollmentSchema).min(1).max(IDE_SESSION_CONFIG_MAX_ENROLLMENTS),
}).strict();

export interface IdeSessionEnrollmentConfig extends z.infer<typeof enrollmentSchema> {}
export interface IdeSessionControlConfig {
  version: typeof IDE_SESSION_CONFIG_VERSION;
  enrollments: IdeSessionEnrollmentConfig[];
}

function malformed(message: string): BridgeError {
  return new BridgeError('MALFORMED_REQUEST', `ide session config: ${message}`, 400);
}

function exactReviewCapabilities(capabilities: readonly IdeCapability[]): boolean {
  if (capabilities.length !== IDE_REVIEW_BASE_CAPABILITIES.length) return false;
  const actual = new Set(capabilities);
  return IDE_REVIEW_BASE_CAPABILITIES.every((entry) => actual.has(entry));
}

export function validateIdeSessionConfig(raw: unknown): IdeSessionControlConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw malformed(`${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}`);
  }

  const seenBindings = new Set<string>();
  const seenRuntimeInstances = new Set<string>();
  for (const enrollment of parsed.data.enrollments) {
    if (!exactReviewCapabilities(enrollment.capabilities)) {
      throw malformed(`enrollment ${enrollment.ideInstanceId}: capabilities must equal the review-only base capability set`);
    }
    const binding = [
      enrollment.principalId,
      enrollment.projectId,
      enrollment.worktreeId,
      enrollment.ideProduct,
      enrollment.ideInstanceId,
    ].join('\u0000');
    if (seenBindings.has(binding)) throw malformed(`duplicate enrollment binding ${enrollment.ideInstanceId}`);
    seenBindings.add(binding);
    if (seenRuntimeInstances.has(enrollment.runtimeInstanceId)) {
      throw malformed(`duplicate runtimeInstanceId ${enrollment.runtimeInstanceId}`);
    }
    seenRuntimeInstances.add(enrollment.runtimeInstanceId);
  }

  return {
    version: IDE_SESSION_CONFIG_VERSION,
    enrollments: parsed.data.enrollments.map((entry) => ({
      ...entry,
      capabilities: [...IDE_REVIEW_BASE_CAPABILITIES],
    })),
  };
}

export function parseIdeSessionConfigYaml(text: string): IdeSessionControlConfig {
  let raw: unknown;
  try { raw = YAML.parse(text); }
  catch (error) { throw malformed(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`); }
  return validateIdeSessionConfig(raw);
}

export function loadIdeSessionConfig(path: string): IdeSessionControlConfig {
  if (!fs.existsSync(path)) throw malformed(`file not found: ${path}`);
  let text: string;
  try { text = fs.readFileSync(path, 'utf8'); }
  catch { throw malformed('trusted config cannot be read'); }
  return parseIdeSessionConfigYaml(text);
}
