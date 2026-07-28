/**
 * Trusted Agent Control Plane configuration (Phase A1 — parser/validator only).
 *
 * This is EXECUTOR-OWNED trusted configuration: it is where logical project
 * ids resolve to real host paths. It is never populated from MCP input, and
 * hostPath is never accepted through any public schema. In A1 nothing loads
 * this at startup — A2 wires it into the executor. See
 * config/agents.example.yaml and docs/AGENT_CONTROL_PLANE.md.
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { BridgeError } from '../shared/errors.js';
import {
  AGENT_BACKEND_IDS,
  AGENT_PROFILE_IDS,
  RESOURCE_POLICY_IDS,
  AGENT_MODEL_CLASSES,
  AGENT_NETWORK_POLICIES,
  AGENT_RETENTION_CLASSES,
  AGENT_PROJECT_ID_PATTERN,
  WRITER_PROFILE_IDS,
  type AgentResourcePolicy,
  type AgentProfilePolicy,
} from '../shared/agents.js';

const backendId = z.enum(AGENT_BACKEND_IDS);
const profileId = z.enum(AGENT_PROFILE_IDS);
const resourcePolicyId = z.enum(RESOURCE_POLICY_IDS);

/** Trusted absolute host path: absolute, no traversal segments, no NUL. */
const hostPath = z.string().min(2).max(4096).refine(
  (p) => p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\0'),
  'hostPath must be an absolute path without .. segments',
);

const backendSchema = z.object({
  id: backendId,
  enabled: z.boolean(),
  profiles: z.array(profileId).nonempty(),
  defaultResourcePolicy: resourcePolicyId,
  // Deliberately NO transport field: the Copilot transport decision is A7's;
  // transport-specific runtime config belongs to the backend adapter phase.
}).strict();

const projectSchema = z.object({
  id: z.string().regex(AGENT_PROJECT_ID_PATTERN, 'invalid project id'),
  hostPath,
  gitRequired: z.boolean(),
  backends: z.array(backendId).nonempty(),
  profiles: z.array(profileId).nonempty(),
  /** Paths refused (or gated harder) by future apply policy. */
  guardedPaths: z.array(z.string().min(1).max(512)).max(256).default([]),
}).strict();

const profileSchema = z.object({
  id: profileId,
  workspaceAccess: z.enum(['read-only', 'sandbox-write']),
  shellPolicy: z.enum(['none', 'read-only', 'validation']),
  gitPolicy: z.enum(['none', 'read', 'sandbox']),
  networkPolicy: z.enum(AGENT_NETWORK_POLICIES),
  defaultResourcePolicy: resourcePolicyId,
}).strict();

const resourcePolicySchema = z.object({
  id: resourcePolicyId,
  modelClass: z.enum(AGENT_MODEL_CLASSES),
  maxRuntimeMs: z.number().int().min(10_000).max(24 * 3_600_000),
  maxCpuMillicores: z.number().int().min(100).max(64_000),
  maxMemoryBytes: z.number().int().min(64 * 1024 * 1024).max(64 * 1024 ** 3),
  maxPids: z.number().int().min(8).max(4096),
  maxOutputBytes: z.number().int().min(1024).max(64 * 1024 * 1024),
  maxEvidenceBytes: z.number().int().min(1024).max(1024 ** 3),
  /** Provider-specific units; only where the backend exposes a controllable limit. */
  maxProviderCredits: z.number().positive().optional(),
  networkPolicy: z.enum(AGENT_NETWORK_POLICIES),
  retentionClass: z.enum(AGENT_RETENTION_CLASSES),
}).strict();

const agentConfigSchema = z.object({
  backends: z.array(backendSchema),
  projects: z.array(projectSchema),
  profiles: z.array(profileSchema),
  resourcePolicies: z.array(resourcePolicySchema),
}).strict();

export interface AgentBackendConfig extends z.infer<typeof backendSchema> {}
export interface AgentProjectConfig extends z.infer<typeof projectSchema> {}
export interface AgentControlPlaneConfig {
  backends: AgentBackendConfig[];
  projects: AgentProjectConfig[];
  profiles: AgentProfilePolicy[];
  resourcePolicies: AgentResourcePolicy[];
}

function malformed(msg: string): BridgeError {
  return new BridgeError('MALFORMED_REQUEST', `agent config: ${msg}`, 400);
}

function requireUnique(kind: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw malformed(`duplicate ${kind} id ${id}`);
    seen.add(id);
  }
}

/**
 * Validate a parsed (already YAML-decoded) agent config object.
 * Strict: unknown keys anywhere, bad ids, relative host paths, duplicate ids,
 * dangling references and out-of-bounds limits are all rejected.
 */
export function validateAgentConfig(raw: unknown): AgentControlPlaneConfig {
  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw malformed(`${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}`);
  }
  const cfg = parsed.data;

  requireUnique('backend', cfg.backends.map((b) => b.id));
  requireUnique('project', cfg.projects.map((p) => p.id));
  requireUnique('profile', cfg.profiles.map((p) => p.id));
  requireUnique('resource policy', cfg.resourcePolicies.map((r) => r.id));

  const profiles = new Set(cfg.profiles.map((p) => p.id));
  const backends = new Set(cfg.backends.map((b) => b.id));
  const policies = new Set(cfg.resourcePolicies.map((r) => r.id));

  for (const b of cfg.backends) {
    for (const pr of b.profiles) if (!profiles.has(pr)) throw malformed(`backend ${b.id}: unknown profile ${pr}`);
    if (!policies.has(b.defaultResourcePolicy)) throw malformed(`backend ${b.id}: unknown resource policy ${b.defaultResourcePolicy}`);
  }
  for (const p of cfg.projects) {
    for (const bk of p.backends) if (!backends.has(bk)) throw malformed(`project ${p.id}: unknown backend ${bk}`);
    for (const pr of p.profiles) if (!profiles.has(pr)) throw malformed(`project ${p.id}: unknown profile ${pr}`);
  }
  for (const p of cfg.profiles) {
    if (!policies.has(p.defaultResourcePolicy)) throw malformed(`profile ${p.id}: unknown resource policy ${p.defaultResourcePolicy}`);
    // Writer invariant: only writer profiles may grant a writable sandbox.
    if (p.workspaceAccess === 'sandbox-write' && !WRITER_PROFILE_IDS.includes(p.id)) {
      throw malformed(`profile ${p.id}: sandbox-write is reserved for writer profiles (${WRITER_PROFILE_IDS.join(', ')})`);
    }
  }

  return cfg;
}

export function parseAgentConfigYaml(text: string): AgentControlPlaneConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw malformed(`invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateAgentConfig(raw);
}

/**
 * Load + validate a trusted agent config file. NOT called at executor
 * startup in A1; agents.yaml is optional and absent by design.
 */
export function loadAgentConfig(path: string): AgentControlPlaneConfig {
  if (!fs.existsSync(path)) throw malformed(`file not found: ${path}`);
  return parseAgentConfigYaml(fs.readFileSync(path, 'utf8'));
}
