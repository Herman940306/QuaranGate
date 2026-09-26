import "server-only";

export type PrincipalMappingResolution =
  | { state: "unmapped" }
  | { state: "mapped-reference"; principalRef: string; mappingVersion: number }
  | { state: "unavailable" }
  | { state: "forbidden" };

export interface PrincipalMappingLookup {
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  expectedMappingVersion?: number;
}

export interface PrincipalMappingWrite {
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  principalRef: string;
}

export interface PrincipalMappingUpdate extends PrincipalMappingWrite {
  status: "active" | "disabled" | "revoked";
  expectedVersion: number;
}

export interface PrincipalMappingRow {
  id: string;
  product_user_id: string;
  organization_id: string;
  workspace_id: string;
  principal_ref: string;
  status: "active" | "disabled" | "revoked";
  version: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}
