import "server-only";

export type ProviderKind = "kiro" | "copilot";
export type ProviderStatus = "enabled" | "disabled";
export type ProviderValidationStatus = "valid" | "invalid" | "unavailable" | "forbidden" | "stale";

export interface ProviderRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  kind: ProviderKind;
  display_label: string;
  display_hint: string | null;
  status: ProviderStatus;
  custody_ref: string | null;
  validation_status: ProviderValidationStatus;
  validation_code: string | null;
  validated_at: string | Date | null;
  version: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface SafeProvider {
  id: string;
  organizationId: string;
  workspaceId: string;
  kind: ProviderKind;
  displayLabel: string;
  displayHint?: string;
  configured: boolean;
  status: ProviderStatus;
  validation: {
    status: ProviderValidationStatus;
    code?: string;
    validatedAt?: string;
  };
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCreate {
  id: string;
  organizationId: string;
  workspaceId: string;
  kind: ProviderKind;
  displayLabel: string;
  displayHint?: string;
  custodyRef?: string;
}

export interface ProviderUpdate {
  id: string;
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  expectedVersion: number;
  displayLabel: string;
  displayHint?: string;
  status: ProviderStatus;
  custodyRef?: string;
}

export interface ProviderValidationUpdate {
  id: string;
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  expectedVersion: number;
  status: ProviderValidationStatus;
  code?: string;
}
