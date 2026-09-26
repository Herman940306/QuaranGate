import type { QueryResultRow } from "pg";

export function isoTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export interface ProductUserRow extends QueryResultRow {
  id: string;
  keycloak_issuer: string;
  keycloak_subject: string;
  display_name: string | null;
  email: string | null;
  email_verified: boolean | null;
  status: "active" | "disabled";
  version: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface OrganizationRow extends QueryResultRow {
  id: string;
  name: string;
  status: "active" | "disabled" | "archived";
  version: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface VisibleOrganizationRow extends OrganizationRow {
  role_classification: string;
}

export interface WorkspaceRow extends QueryResultRow {
  id: string;
  organization_id: string;
  name: string;
  status: "active" | "disabled" | "archived";
  version: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface VisibleWorkspaceRow extends WorkspaceRow {
  organization_name: string;
  role_classification: string;
}

export interface PermissionRow extends QueryResultRow {
  permission_key: string;
  enabled?: boolean;
  effect?: "allow" | "deny";
  workspace_id?: string | null;
}

export interface PreferenceRow extends QueryResultRow {
  product_user_id: string;
  appearance_mode: "system" | "light" | "dark";
  palette: string;
  density: "comfortable" | "compact";
  version: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}
