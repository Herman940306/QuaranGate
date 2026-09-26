/** Semantic seams only. No HTTP routes, custody implementation or operational grants. */
export interface ProductContext { userId: string; organizationId: string; workspaceId: string; sessionVersion: string }
export const failureKinds = ["integration_pending", "unavailable", "forbidden", "stale", "conflict", "cancelled"] as const;
export type FailureKind = typeof failureKinds[number];
export type Result<T> = { kind: "available"; data: T } | { kind: FailureKind };
export type ValidationStatus = "unknown" | "pending" | "succeeded" | "failed";
export interface ProviderView { id: string; kind: string; ownerScope: string; configured: boolean; maskedHint?: string; validation: ValidationStatus; updatedAt: string; version: string }
export interface Option { id: string; label: string }
export interface ProfileView { id: string; name: string; backend: string; acpProfile: string; project: string; resourcePolicy: string; capabilities: string[]; version: string }
export interface ProductOptions { version: string; providerKinds: Option[]; ownerScopes: Option[]; backends: Option[]; acpProfiles: Option[]; projects: Option[]; resourcePolicies: Option[]; capabilities: Option[] }
export interface Inventory<T> { items: T[]; options: ProductOptions }
export interface ProviderIntent { id?: string; kind: string; ownerScope: string; expectedVersion?: string; optionsVersion: string; secretValue?: string }
export interface ProfileIntent { id?: string; name: string; backend: string; acpProfile: string; project: string; resourcePolicy: string; capabilities: string[]; expectedVersion?: string; optionsVersion: string }
export interface ProductAdapter {
  listProviders(context: ProductContext, signal: AbortSignal): Promise<unknown>;
  inspectProvider(context: ProductContext, id: string, signal: AbortSignal): Promise<unknown>;
  saveProvider(context: ProductContext, intent: ProviderIntent, signal: AbortSignal): Promise<unknown>;
  validateProvider(context: ProductContext, id: string, expectedVersion: string, signal: AbortSignal): Promise<unknown>;
  listProfiles(context: ProductContext, signal: AbortSignal): Promise<unknown>;
  inspectProfile(context: ProductContext, id: string, signal: AbortSignal): Promise<unknown>;
  saveProfile(context: ProductContext, intent: ProfileIntent, signal: AbortSignal): Promise<unknown>;
}
export interface ProductClient {
  readonly integrated: boolean;
  listProviders(context: ProductContext, signal: AbortSignal): Promise<Result<Inventory<ProviderView>>>;
  inspectProvider(context: ProductContext, id: string, signal: AbortSignal): Promise<Result<ProviderView>>;
  saveProvider(context: ProductContext, intent: ProviderIntent, options: ProductOptions, signal: AbortSignal): Promise<Result<ProviderView>>;
  validateProvider(context: ProductContext, id: string, expectedVersion: string, signal: AbortSignal): Promise<Result<ProviderView>>;
  listProfiles(context: ProductContext, signal: AbortSignal): Promise<Result<Inventory<ProfileView>>>;
  inspectProfile(context: ProductContext, id: string, signal: AbortSignal): Promise<Result<ProfileView>>;
  saveProfile(context: ProductContext, intent: ProfileIntent, options: ProductOptions, signal: AbortSignal): Promise<Result<ProfileView>>;
}
export const productCopy: Record<FailureKind | "loading", string> = {
  integration_pending: "Product integration pending. Configuration is unavailable until an accepted server adapter is connected.",
  loading: "Waiting for the configuration service.", unavailable: "Configuration service unavailable. Re-read to reconcile; no change is assumed.",
  forbidden: "Configuration access forbidden. Check current workspace membership with an administrator.",
  stale: "Configuration version changed. Re-read and explicitly edit the current version; no automatic retry.",
  conflict: "Configuration conflict. Re-read to reconcile; no change is assumed.",
  cancelled: "Request cancelled. A server change may have completed; re-read to reconcile.",
};
