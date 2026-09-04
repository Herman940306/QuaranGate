#!/usr/bin/env node
// Validate config/bridge.yaml and config/clients.yaml without starting services.
// Optionally validates an Agent Control Plane config (config/agents.yaml or
// $AGENTS_CONFIG) when present — agents.yaml is NOT required for the bridge.
import fs from 'node:fs';
import YAML from 'yaml';

let errors = 0;
const fail = (m) => { console.error('  ✗', m); errors++; };
const ok = (m) => console.log('  ✓', m);

const validScopes = new Set([
  'targets:read','files:read','files:write','files:delete','terminal:exec','git:read','process:read',
  'agents:read','agents:dispatch','agents:cancel','agents:apply',
]);
const agentBackendIds = new Set(['kiro','copilot','ollama']);
const agentProfileIds = new Set(['audit','plan','implement','review']);
const resourcePolicyIds = new Set(['economy','standard','deep']);
const agentModelClasses = new Set(['fast','standard','deep']);
const projectIdRe = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function checkStringList(c, field) {
  const v = c[field];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    fail(`client ${c.id}: ${field} must be a list of strings`);
    return [];
  }
  return v;
}

function checkClients(path) {
  console.log('clients:', path);
  if (!fs.existsSync(path)) return fail('file missing');
  const doc = YAML.parse(fs.readFileSync(path, 'utf8'));
  const ids = new Set();
  for (const c of doc.clients ?? []) {
    if (!c.id) fail('client missing id');
    if (ids.has(c.id)) fail(`duplicate client id ${c.id}`); else ids.add(c.id);
    if (!c.keyHash || /^<.*>$/.test(c.keyHash)) fail(`client ${c.id}: keyHash not set (run gen-key)`);
    else if (!/^[0-9a-f]{64}$/.test(c.keyHash)) fail(`client ${c.id}: keyHash is not a sha256 hex`);
    for (const s of c.scopes ?? []) if (!validScopes.has(s)) fail(`client ${c.id}: unknown scope ${s}`);
    if (!Array.isArray(c.targets)) fail(`client ${c.id}: targets must be a list`);
    // Agent grants (optional; absent = deny). "*" = whole trusted registry.
    for (const p of checkStringList(c, 'projects')) {
      if (p !== '*' && !projectIdRe.test(p)) fail(`client ${c.id}: invalid project id ${p}`);
    }
    for (const b of checkStringList(c, 'agentBackends')) {
      if (b !== '*' && !agentBackendIds.has(b)) fail(`client ${c.id}: unknown agent backend ${b}`);
    }
    for (const pr of checkStringList(c, 'agentProfiles')) {
      if (pr !== '*' && !agentProfileIds.has(pr)) fail(`client ${c.id}: unknown agent profile ${pr}`);
    }
  }
  if (!errors) ok(`${(doc.clients ?? []).length} client(s) valid`);
}

function checkBridge(path) {
  console.log('targets:', path);
  if (!fs.existsSync(path)) return fail('file missing');
  const doc = YAML.parse(fs.readFileSync(path, 'utf8'));
  const ids = new Set();
  for (const t of doc.targets ?? []) {
    if (!t.id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.id)) fail(`invalid target id ${JSON.stringify(t.id)}`);
    if (ids.has(t.id)) fail(`duplicate target id ${t.id}`); else ids.add(t.id);
    if (!t.workspace || !t.workspace.startsWith('/')) fail(`target ${t.id}: workspace must be absolute`);
    if (!t.containerName && !(t.composeProject && t.composeService)) fail(`target ${t.id}: needs composeProject+composeService or containerName`);
  }
  if (!errors) ok(`${(doc.targets ?? []).length} target(s) valid`);
}

function checkKeys(kind, obj, allowed, ctx) {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) fail(`${ctx}: unknown ${kind} key ${k}`);
}

function checkBoundedStringList(obj, field, ctx) {
  const value = obj[field];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    fail(`${ctx}: ${field} must be a list`);
    return;
  }
  if (value.length > 256) fail(`${ctx}: ${field} must have at most 256 entries`);
  for (const item of value) {
    if (typeof item !== 'string') {
      fail(`${ctx}: ${field} entries must be strings`);
    } else if (item.length < 1 || item.length > 512) {
      fail(`${ctx}: ${field} entries must be 1..512 characters`);
    }
  }
}

function checkRequiredArray(obj, field, ctx) {
  const value = obj[field];
  if (!Array.isArray(value)) {
    fail(`${ctx}: ${field} must be a list`);
    return [];
  }
  return value;
}

function checkNonEmptyIdList(obj, field, ctx, validIds, kind) {
  const value = obj[field];
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${ctx}: ${field} must be a non-empty list`);
    return [];
  }
  for (const id of value) if (!validIds.has(id)) fail(`${ctx}: unknown ${kind} ${id}`);
  return value;
}

function checkIntegerRange(obj, field, min, max, ctx) {
  const value = obj[field];
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${ctx}: ${field} must be an integer in range ${min}..${max}`);
  }
}

function checkAgents(path) {
  console.log('agents:', path);
  if (!fs.existsSync(path)) return fail('file missing');
  const doc = YAML.parse(fs.readFileSync(path, 'utf8'));
  if (!doc || typeof doc !== 'object') return fail('not a mapping');
  checkKeys('top-level', doc, new Set(['backends','projects','profiles','resourcePolicies']), 'agents');

  const backends = checkRequiredArray(doc, 'backends', 'agents');
  const projects = checkRequiredArray(doc, 'projects', 'agents');
  const profiles = checkRequiredArray(doc, 'profiles', 'agents');
  const resourcePolicies = checkRequiredArray(doc, 'resourcePolicies', 'agents');

  const seen = { backend: new Set(), project: new Set(), profile: new Set(), policy: new Set() };
  for (const b of backends) {
    checkKeys('backend', b, new Set(['id','enabled','profiles','defaultResourcePolicy']), `backend ${b.id}`);
    if (!agentBackendIds.has(b.id)) fail(`unknown backend id ${b.id}`);
    if (seen.backend.has(b.id)) fail(`duplicate backend id ${b.id}`); else seen.backend.add(b.id);
    if (typeof b.enabled !== 'boolean') fail(`backend ${b.id}: enabled must be boolean`);
    checkNonEmptyIdList(b, 'profiles', `backend ${b.id}`, agentProfileIds, 'profile');
    if (!resourcePolicyIds.has(b.defaultResourcePolicy)) fail(`backend ${b.id}: unknown resource policy ${b.defaultResourcePolicy}`);
  }
  for (const p of projects) {
    checkKeys('project', p, new Set(['id','hostPath','gitRequired','backends','profiles','guardedPaths','sensitiveReadGlobs']), `project ${p.id}`);
    if (!p.id || !projectIdRe.test(p.id)) fail(`invalid project id ${JSON.stringify(p.id)}`);
    if (seen.project.has(p.id)) fail(`duplicate project id ${p.id}`); else seen.project.add(p.id);
    if (typeof p.hostPath !== 'string' || p.hostPath.length < 2 || p.hostPath.length > 4096 || !p.hostPath.startsWith('/') || p.hostPath.split('/').includes('..') || p.hostPath.includes('\0')) {
      fail(`project ${p.id}: hostPath must be 2..4096 characters, absolute, without .. segments or NUL`);
    }
    if (typeof p.gitRequired !== 'boolean') fail(`project ${p.id}: gitRequired must be boolean`);
    checkNonEmptyIdList(p, 'backends', `project ${p.id}`, agentBackendIds, 'backend');
    checkNonEmptyIdList(p, 'profiles', `project ${p.id}`, agentProfileIds, 'profile');
    checkBoundedStringList(p, 'guardedPaths', `project ${p.id}`);
    checkBoundedStringList(p, 'sensitiveReadGlobs', `project ${p.id}`);
  }
  for (const p of profiles) {
    checkKeys('profile', p, new Set(['id','workspaceAccess','shellPolicy','gitPolicy','networkPolicy','defaultResourcePolicy']), `profile ${p.id}`);
    if (!agentProfileIds.has(p.id)) fail(`unknown profile id ${p.id}`);
    if (seen.profile.has(p.id)) fail(`duplicate profile id ${p.id}`); else seen.profile.add(p.id);
    if (!['read-only','sandbox-write'].includes(p.workspaceAccess)) fail(`profile ${p.id}: bad workspaceAccess`);
    if (p.workspaceAccess === 'sandbox-write' && p.id !== 'implement') fail(`profile ${p.id}: sandbox-write is reserved for writer profiles (implement)`);
    if (!['none','read-only','validation'].includes(p.shellPolicy)) fail(`profile ${p.id}: bad shellPolicy`);
    if (!['none','read','sandbox'].includes(p.gitPolicy)) fail(`profile ${p.id}: bad gitPolicy`);
    if (!['deny','backend-only'].includes(p.networkPolicy)) fail(`profile ${p.id}: bad networkPolicy`);
    if (!resourcePolicyIds.has(p.defaultResourcePolicy)) fail(`profile ${p.id}: unknown resource policy ${p.defaultResourcePolicy}`);
  }
  for (const r of resourcePolicies) {
    checkKeys('resource policy', r, new Set(['id','modelClass','maxRuntimeMs','maxCpuMillicores','maxMemoryBytes','maxPids','maxOutputBytes','maxEvidenceBytes','maxProviderCredits','networkPolicy','retentionClass']), `policy ${r.id}`);
    if (!resourcePolicyIds.has(r.id)) fail(`unknown resource policy id ${r.id}`);
    if (seen.policy.has(r.id)) fail(`duplicate resource policy id ${r.id}`); else seen.policy.add(r.id);
    if (!agentModelClasses.has(r.modelClass)) fail(`policy ${r.id}: bad modelClass`);
    checkIntegerRange(r, 'maxRuntimeMs', 10_000, 86_400_000, `policy ${r.id}`);
    checkIntegerRange(r, 'maxCpuMillicores', 100, 64_000, `policy ${r.id}`);
    checkIntegerRange(r, 'maxMemoryBytes', 67_108_864, 68_719_476_736, `policy ${r.id}`);
    checkIntegerRange(r, 'maxPids', 8, 4096, `policy ${r.id}`);
    checkIntegerRange(r, 'maxOutputBytes', 1024, 67_108_864, `policy ${r.id}`);
    checkIntegerRange(r, 'maxEvidenceBytes', 1024, 1_073_741_824, `policy ${r.id}`);
    if (r.maxProviderCredits !== undefined && (typeof r.maxProviderCredits !== 'number' || !Number.isFinite(r.maxProviderCredits) || r.maxProviderCredits <= 0)) {
      fail(`policy ${r.id}: maxProviderCredits must be a positive number`);
    }
    if (!['deny','backend-only'].includes(r.networkPolicy)) fail(`policy ${r.id}: bad networkPolicy`);
    if (!['ephemeral','short','audit'].includes(r.retentionClass)) fail(`policy ${r.id}: bad retentionClass`);
  }

  for (const b of backends) {
    for (const p of Array.isArray(b.profiles) ? b.profiles : []) {
      if (agentProfileIds.has(p) && !seen.profile.has(p)) fail(`backend ${b.id}: unknown profile ${p}`);
    }
    if (resourcePolicyIds.has(b.defaultResourcePolicy) && !seen.policy.has(b.defaultResourcePolicy)) fail(`backend ${b.id}: unknown resource policy ${b.defaultResourcePolicy}`);
  }
  for (const p of projects) {
    for (const b of Array.isArray(p.backends) ? p.backends : []) {
      if (agentBackendIds.has(b) && !seen.backend.has(b)) fail(`project ${p.id}: unknown backend ${b}`);
    }
    for (const pr of Array.isArray(p.profiles) ? p.profiles : []) {
      if (agentProfileIds.has(pr) && !seen.profile.has(pr)) fail(`project ${p.id}: unknown profile ${pr}`);
    }
  }
  for (const p of profiles) {
    if (resourcePolicyIds.has(p.defaultResourcePolicy) && !seen.policy.has(p.defaultResourcePolicy)) fail(`profile ${p.id}: unknown resource policy ${p.defaultResourcePolicy}`);
  }
  if (!errors) ok(`agents config valid (${projects.length} project(s), ${backends.length} backend(s))`);
}

checkClients(process.env.CLIENTS_CONFIG ?? 'config/clients.yaml');
checkBridge(process.env.BRIDGE_CONFIG ?? 'config/bridge.yaml');
const agentsPath = process.env.AGENTS_CONFIG ?? 'config/agents.yaml';
if (process.env.AGENTS_CONFIG || fs.existsSync(agentsPath)) checkAgents(agentsPath);
else console.log('agents: config/agents.yaml not present (optional — Agent Dispatch inactive)');
process.exitCode = errors ? 1 : 0;
