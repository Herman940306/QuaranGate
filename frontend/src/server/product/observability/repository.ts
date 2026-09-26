import "server-only";
import type { QueryExecutor } from "../data/db";

export interface ProductEventSummaryRow extends Record<string, unknown> {
  event_type: string;
  count: string | number;
}

export interface ProductEventSampleRow extends Record<string, unknown> {
  event_type: string;
  created_at: string | Date;
}

export interface ProviderHealthRow extends Record<string, unknown> {
  validation_status: string;
  count: string | number;
}

export interface ApprovalStatusRow extends Record<string, unknown> {
  status: string;
  count: string | number;
}

export class ObservabilityRepository {
  constructor(private readonly db: QueryExecutor) {}

  async eventCounts(productUserId: string, organizationId: string, workspaceId: string, start: Date, end: Date): Promise<Record<string, number>> {
    const result = await this.db.query<ProductEventSummaryRow>(
      `SELECT e.event_type, COUNT(*) AS count
       FROM product_events e
       JOIN memberships m
         ON m.product_user_id = $1
        AND m.organization_id = e.organization_id
        AND m.workspace_id = e.workspace_id
        AND m.status = 'active'
       JOIN product_users u ON u.id = m.product_user_id AND u.status = 'active'
       WHERE e.organization_id = $2
         AND e.workspace_id = $3
         AND e.created_at >= $4
         AND e.created_at < $5
       GROUP BY e.event_type
       ORDER BY count DESC, e.event_type ASC
       LIMIT 100`,
      [productUserId, organizationId, workspaceId, start.toISOString(), end.toISOString()],
    );
    return Object.fromEntries(result.rows.map((row) => [row.event_type, Number(row.count)]));
  }

  async eventSamples(productUserId: string, organizationId: string, workspaceId: string, start: Date, end: Date, limit = 200): Promise<ProductEventSampleRow[]> {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const result = await this.db.query<ProductEventSampleRow>(
      `SELECT e.event_type, e.created_at
       FROM product_events e
       JOIN memberships m
         ON m.product_user_id = $1
        AND m.organization_id = e.organization_id
        AND m.workspace_id = e.workspace_id
        AND m.status = 'active'
       WHERE e.organization_id = $2
         AND e.workspace_id = $3
         AND e.created_at >= $4
         AND e.created_at < $5
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $6`,
      [productUserId, organizationId, workspaceId, start.toISOString(), end.toISOString(), bounded],
    );
    return result.rows;
  }

  async providerHealth(productUserId: string, organizationId: string, workspaceId: string): Promise<Record<string, number>> {
    const result = await this.db.query<ProviderHealthRow>(
      `SELECT p.validation_status, COUNT(*) AS count
       FROM product_providers p
       JOIN memberships m
         ON m.product_user_id = $1
        AND m.organization_id = p.organization_id
        AND m.workspace_id = p.workspace_id
        AND m.status = 'active'
       WHERE p.organization_id = $2
         AND p.workspace_id = $3
       GROUP BY p.validation_status
       ORDER BY p.validation_status ASC`,
      [productUserId, organizationId, workspaceId],
    );
    return Object.fromEntries(result.rows.map((row) => [row.validation_status, Number(row.count)]));
  }

  async approvalCounts(productUserId: string, organizationId: string, workspaceId: string, start: Date, end: Date): Promise<Record<string, number>> {
    const result = await this.db.query<ApprovalStatusRow>(
      `SELECT a.status, COUNT(*) AS count
       FROM product_approvals a
       JOIN memberships m
         ON m.product_user_id = $1
        AND m.organization_id = a.organization_id
        AND m.workspace_id = a.workspace_id
        AND m.status = 'active'
       WHERE a.organization_id = $2
         AND a.workspace_id = $3
         AND a.created_at >= $4
         AND a.created_at < $5
       GROUP BY a.status
       ORDER BY a.status ASC`,
      [productUserId, organizationId, workspaceId, start.toISOString(), end.toISOString()],
    );
    return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
  }
}
