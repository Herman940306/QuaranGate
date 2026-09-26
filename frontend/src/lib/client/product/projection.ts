import type { ProductContext, ProductOptions, ProfileView, ProviderView, Option, ValidationStatus } from "./contracts";
export function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid view"); return value as Record<string, unknown>; }
export function text(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 256 || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error("Invalid field"); return value; }
export function list<T>(value: unknown, parse: (v: unknown) => T): T[] { if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid list"); return value.map(parse); }
export function unique<T extends { id: string }>(items: T[]): T[] { if (new Set(items.map(i => i.id)).size !== items.length) throw new Error("Duplicate IDs"); return items; }
export function context(input: unknown): ProductContext { const v = record(input); return { userId: text(v.userId), organizationId: text(v.organizationId), workspaceId: text(v.workspaceId), sessionVersion: text(v.sessionVersion) }; }
export function sameContext(a: ProductContext, b: ProductContext): boolean { return a.userId === b.userId && a.organizationId === b.organizationId && a.workspaceId === b.workspaceId && a.sessionVersion === b.sessionVersion; }
function option(input: unknown): Option { const v = record(input); return { id: text(v.id), label: text(v.label) }; }
export function options(input: unknown): ProductOptions { const v = record(input); return { version: text(v.version), providerKinds: unique(list(v.providerKinds, option)), ownerScopes: unique(list(v.ownerScopes, option)), backends: unique(list(v.backends, option)), acpProfiles: unique(list(v.acpProfiles, option)), projects: unique(list(v.projects, option)), resourcePolicies: unique(list(v.resourcePolicies, option)), capabilities: unique(list(v.capabilities, option)) }; }
export function provider(input: unknown): ProviderView {
  const v = record(input); if (typeof v.configured !== "boolean" || !["unknown", "pending", "succeeded", "failed"].includes(String(v.validation))) throw new Error("Invalid provider");
  const updatedAt = text(v.updatedAt); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) throw new Error("Invalid timestamp");
  return { id: text(v.id), kind: text(v.kind), ownerScope: text(v.ownerScope), configured: v.configured, ...(v.maskedHint === undefined ? {} : { maskedHint: text(v.maskedHint) }), validation: v.validation as ValidationStatus, updatedAt, version: text(v.version) };
}
export function profile(input: unknown): ProfileView {
  const v = record(input); const capabilities = list(v.capabilities, text); if (new Set(capabilities).size !== capabilities.length) throw new Error("Duplicate capabilities");
  return { id: text(v.id), name: text(v.name), backend: text(v.backend), acpProfile: text(v.acpProfile), project: text(v.project), resourcePolicy: text(v.resourcePolicy), capabilities, version: text(v.version) };
}
export function allowed(id: string, items: Option[]): string { const valid = text(id); if (!items.some(i => i.id === valid)) throw new Error("Unknown option"); return valid; }
