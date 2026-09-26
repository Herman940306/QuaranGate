import "server-only";
import type { QueryExecutor } from "./db";
import type { OrganizationRow, PermissionRow, VisibleOrganizationRow, VisibleWorkspaceRow, WorkspaceRow } from "./rows";
import { isoTimestamp } from "./rows";
import type { EffectiveProductRole, OrganizationRecord, WorkspaceRecord } from "./types";

export interface VisibleOrganization {
  organization: OrganizationRecord;
  roleClassification: string;
}

export interface VisibleWorkspace {
  workspace: WorkspaceRecord;
  organizationName: string;
  roleClassification: string;
}

function mapOrganization(row: OrganizationRow): OrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    version: Number(row.version),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    status: row.status,
    version: Number(row.version),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

export class ProductContextRepository {
  constructor(private readonly db: QueryExecutor) {}

  async listVisibleOrganizations(productUserId: string): Promise<VisibleOrganization[]> {
    const result = await this.db.query<VisibleOrganizationRow>(
      `SELECT o.*, m.role_classification
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.product_user_id = $1
         AND m.workspace_id IS NULL
         AND m.status = 'active'
         AND o.status = 'active'
       ORDER BY o.name, o.id`,
      [productUserId],
    );
    return result.rows.map((row) => ({
      organization: mapOrganization(row),
      roleClassification: row.role_classification,
    }));
  }

  async listVisibleWorkspaces(productUserId: string): Promise<VisibleWorkspace[]> {
    const result = await this.db.query<VisibleWorkspaceRow>(
      `SELECT w.*, o.name AS organization_name, m.role_classification
       FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id AND w.organization_id = m.organization_id
       JOIN organizations o ON o.id = w.organization_id
       WHERE m.product_user_id = $1
         AND m.workspace_id IS NOT NULL
         AND m.status = 'active'
         AND w.status = 'active'
         AND o.status = 'active'
       ORDER BY o.name, w.name, w.id`,
      [productUserId],
    );
    return result.rows.map((row) => ({
      workspace: mapWorkspace(row),
      organizationName: row.organization_name,
      roleClassification: row.role_classification,
    }));
  }

  async resolveWorkspaceMembership(productUserId: string, workspaceId: string): Promise<WorkspaceRecord | undefined> {
    const result = await this.db.query<WorkspaceRow>(
      `SELECT w.*
       FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id AND w.organization_id = m.organization_id
       JOIN organizations o ON o.id = w.organization_id
       WHERE m.product_user_id = $1
         AND m.workspace_id = $2
         AND m.status = 'active'
         AND w.status = 'active'
         AND o.status = 'active'
       LIMIT 1`,
      [productUserId, workspaceId],
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : undefined;
  }

  async effectiveProductRole(productUserId: string, workspaceId: string): Promise<EffectiveProductRole | undefined> {
    const membership = await this.db.query<{ role_classification: string; organization_id: string }>(
      `SELECT m.role_classification, m.organization_id
       FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id AND w.organization_id = m.organization_id
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.product_user_id = $1
         AND m.workspace_id = $2
         AND m.status = 'active'
         AND w.status = 'active'
         AND o.status = 'active'
       LIMIT 1`,
      [productUserId, workspaceId],
    );
    const row = membership.rows[0];
    if (!row) return undefined;

    const defaults = await this.db.query<PermissionRow>(
      `SELECT permission_key, enabled
       FROM product_role_defaults
       WHERE role_classification = $1`,
      [row.role_classification],
    );
    const overrides = await this.db.query<PermissionRow>(
      `SELECT permission_key, effect, workspace_id
       FROM product_permission_overrides
       WHERE product_user_id = $1
         AND organization_id = $2
         AND (workspace_id IS NULL OR workspace_id = $3)
       ORDER BY workspace_id NULLS FIRST, permission_key`,
      [productUserId, row.organization_id, workspaceId],
    );

    const permissions = new Map<string, boolean>();
    for (const entry of defaults.rows) permissions.set(entry.permission_key, entry.enabled === true);
    for (const entry of overrides.rows) permissions.set(entry.permission_key, entry.effect === "allow");

    return {
      roleClassification: row.role_classification,
      permissions: [...permissions.entries()]
        .filter(([, enabled]) => enabled)
        .map(([permission]) => permission)
        .sort(),
    };
  }
}
