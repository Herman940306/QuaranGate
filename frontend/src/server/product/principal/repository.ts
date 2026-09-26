import "server-only";
import { randomUUID } from "node:crypto";
import type { QueryExecutor, QueryResultLike } from "../data/db";
import { ProductDataError } from "../data/errors";
import type {
  PrincipalMappingLookup,
  PrincipalMappingResolution,
  PrincipalMappingRow,
  PrincipalMappingUpdate,
  PrincipalMappingWrite,
} from "./types";

export class PrincipalMappingRepository {
  constructor(private readonly db: QueryExecutor) {}

  private assertPrincipalRef(principalRef: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(principalRef)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "principal_mapping_reference_invalid");
    }
  }

  async create(input: PrincipalMappingWrite): Promise<PrincipalMappingResolution> {
    this.assertPrincipalRef(input.principalRef);
    const result = await this.db.query<PrincipalMappingRow>(
      `INSERT INTO product_principal_mappings(
         id, product_user_id, organization_id, workspace_id, principal_ref
       )
       SELECT $1, $2, $3, $4, $5
       FROM product_users pu
       JOIN memberships m
         ON m.product_user_id = pu.id
        AND m.organization_id = $3
        AND m.workspace_id = $4
        AND m.status = 'active'
       JOIN workspaces w
         ON w.id = m.workspace_id
        AND w.organization_id = m.organization_id
        AND w.status = 'active'
       JOIN organizations o
         ON o.id = m.organization_id
        AND o.status = 'active'
       WHERE pu.id = $2
         AND pu.status = 'active'
       ON CONFLICT (product_user_id, workspace_id) DO NOTHING
       RETURNING *`,
      [randomUUID(), input.productUserId, input.organizationId, input.workspaceId, input.principalRef],
    );
    const row = result.rows[0];
    if (!row) return { state: "forbidden" };
    return { state: "mapped-reference", principalRef: row.principal_ref, mappingVersion: Number(row.version) };
  }

  async update(input: PrincipalMappingUpdate): Promise<PrincipalMappingResolution> {
    this.assertPrincipalRef(input.principalRef);
    const result = await this.db.query<PrincipalMappingRow>(
      `UPDATE product_principal_mappings
       SET principal_ref = $1,
           status = $2,
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE product_user_id = $3
         AND organization_id = $4
         AND workspace_id = $5
         AND version = $6
       RETURNING *`,
      [input.principalRef, input.status, input.productUserId, input.organizationId, input.workspaceId, input.expectedVersion],
    );
    const row = result.rows[0];
    if (!row) return { state: "unavailable" };
    if (row.status !== "active") return { state: "forbidden" };
    return { state: "mapped-reference", principalRef: row.principal_ref, mappingVersion: Number(row.version) };
  }

  async resolve(input: PrincipalMappingLookup): Promise<PrincipalMappingResolution> {
    let result: QueryResultLike<PrincipalMappingRow>;
    try {
      result = await this.db.query<PrincipalMappingRow>(
        `SELECT pm.*
         FROM product_principal_mappings pm
         JOIN product_users pu
           ON pu.id = pm.product_user_id
          AND pu.status = 'active'
         JOIN memberships m
           ON m.product_user_id = pm.product_user_id
          AND m.organization_id = pm.organization_id
          AND m.workspace_id = pm.workspace_id
         JOIN workspaces w
           ON w.id = pm.workspace_id
          AND w.organization_id = pm.organization_id
         JOIN organizations o ON o.id = pm.organization_id
         WHERE pm.product_user_id = $1
           AND pm.organization_id = $2
           AND pm.workspace_id = $3
           AND m.status = 'active'
           AND w.status = 'active'
           AND o.status = 'active'
         LIMIT 2`,
        [input.productUserId, input.organizationId, input.workspaceId],
      );
    } catch {
      return { state: "unavailable" };
    }

    if (result.rows.length === 0) return { state: "unmapped" };
    if (result.rows.length !== 1) return { state: "unavailable" };

    const row = result.rows[0];
    if (!row) return { state: "unavailable" };
    if (row.status !== "active") return { state: "forbidden" };

    const mappingVersion = Number(row.version);
    if (!Number.isSafeInteger(mappingVersion) || mappingVersion < 0) return { state: "unavailable" };
    if (input.expectedMappingVersion !== undefined && input.expectedMappingVersion !== mappingVersion) {
      return { state: "unavailable" };
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(row.principal_ref)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "principal_mapping_reference_invalid");
    }

    return { state: "mapped-reference", principalRef: row.principal_ref, mappingVersion };
  }
}
