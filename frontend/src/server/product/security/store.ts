import "server-only";
import type { QueryExecutor } from "../data/db";
import { ProductDataError } from "../data/errors";
import { canonicalSnapshot } from "./assessment/snapshot";
import { validateSecurityDiscoveryResult } from "./assessment/repository";
import type { StoredSecurityDiscovery } from "./types";

export interface SecurityDiscoveryStore {
  put(entry: StoredSecurityDiscovery): Promise<void>;
  get(discoveryId: string): Promise<StoredSecurityDiscovery | undefined>;
  getForPrincipal(discoveryId: string, principalRef: string): Promise<StoredSecurityDiscovery | undefined>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertOwner(entry: StoredSecurityDiscovery): void {
  for (const [value, code] of [
    [entry.productUserId, "security_discovery_product_user_invalid"],
    [entry.organizationId, "security_discovery_organization_invalid"],
    [entry.workspaceId, "security_discovery_workspace_invalid"],
  ] as const) {
    if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.includes("\0")) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", code);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(entry.principalRef)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "security_discovery_principal_invalid");
  }
  if (!Number.isSafeInteger(entry.principalMappingVersion) || entry.principalMappingVersion < 0) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "security_discovery_principal_version_invalid");
  }
  validateSecurityDiscoveryResult(entry.result);
}

export class MemorySecurityDiscoveryStore implements SecurityDiscoveryStore {
  private readonly entries = new Map<string, StoredSecurityDiscovery>();

  constructor(private readonly maxEntries = 256) {}

  async put(entry: StoredSecurityDiscovery): Promise<void> {
    assertOwner(entry);
    if (this.entries.size >= this.maxEntries && !this.entries.has(entry.result.discoveryId)) {
      const first = this.entries.keys().next().value as string | undefined;
      if (first) this.entries.delete(first);
    }
    this.entries.set(entry.result.discoveryId, clone(entry));
  }

  async get(discoveryId: string): Promise<StoredSecurityDiscovery | undefined> {
    const entry = this.entries.get(discoveryId);
    if (!entry) return undefined;
    assertOwner(entry);
    return clone(entry);
  }

  async getForPrincipal(discoveryId: string, principalRef: string): Promise<StoredSecurityDiscovery | undefined> {
    const entry = await this.get(discoveryId);
    if (!entry || entry.principalRef !== principalRef) return undefined;
    return entry;
  }
}

interface DiscoveryRow {
  discovery_id: string;
  product_user_id: string;
  organization_id: string;
  workspace_id: string;
  principal_ref: string;
  principal_mapping_version: string | number;
  source_revision: string;
  snapshot_schema_version: string;
  snapshot_json: unknown;
  snapshot_digest_sha256: string;
  snapshot_byte_length: number;
}

export class PostgresSecurityDiscoveryStore implements SecurityDiscoveryStore {
  constructor(private readonly db: QueryExecutor) {}

  async put(entry: StoredSecurityDiscovery): Promise<void> {
    assertOwner(entry);
    const snapshot = canonicalSnapshot(entry.result);
    await this.db.query(
      `INSERT INTO security_discoveries(
         discovery_id, product_user_id, organization_id, workspace_id,
         principal_ref, principal_mapping_version, project_id, target_id, source_revision,
         snapshot_schema_version, snapshot_json, snapshot_digest_sha256,
         snapshot_byte_length
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'BE9_DISCOVERY_SNAPSHOT_V1',$10::jsonb,$11,$12)
       ON CONFLICT (discovery_id) DO NOTHING`,
      [
        entry.result.discoveryId,
        entry.productUserId,
        entry.organizationId,
        entry.workspaceId,
        entry.principalRef,
        entry.principalMappingVersion,
        entry.result.projectId,
        entry.result.targetId ?? null,
        entry.result.sourceRevision,
        JSON.stringify(entry.result),
        snapshot.digest,
        snapshot.byteLength,
      ],
    );

    const stored = await this.get(entry.result.discoveryId);
    if (!stored) {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_discovery_persist_failed");
    }
    const storedSnapshot = canonicalSnapshot(stored.result);
    if (
      stored.productUserId !== entry.productUserId
      || stored.organizationId !== entry.organizationId
      || stored.workspaceId !== entry.workspaceId
      || stored.principalRef !== entry.principalRef
      || stored.principalMappingVersion !== entry.principalMappingVersion
      || storedSnapshot.digest !== snapshot.digest
    ) {
      throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "security_discovery_id_collision");
    }
  }

  async get(discoveryId: string): Promise<StoredSecurityDiscovery | undefined> {
    if (!/^disc_[0-9a-f]{24}$/.test(discoveryId)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "security_discovery_id_invalid");
    }
    const result = await this.db.query<DiscoveryRow & Record<string, unknown>>(
      `SELECT discovery_id, product_user_id, organization_id, workspace_id,
              principal_ref, principal_mapping_version, source_revision, snapshot_schema_version,
              snapshot_json, snapshot_digest_sha256, snapshot_byte_length
         FROM security_discoveries
        WHERE discovery_id = $1
        LIMIT 1`,
      [discoveryId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.snapshot_schema_version !== "BE9_DISCOVERY_SNAPSHOT_V1") {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "security_discovery_snapshot_schema_invalid");
    }

    const entry: StoredSecurityDiscovery = {
      productUserId: row.product_user_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      principalRef: row.principal_ref,
      principalMappingVersion: Number(row.principal_mapping_version),
      result: row.snapshot_json as StoredSecurityDiscovery["result"],
    };
    assertOwner(entry);
    if (
      entry.result.discoveryId !== row.discovery_id
      || entry.result.sourceRevision !== row.source_revision
    ) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "security_discovery_binding_mismatch");
    }
    const snapshot = canonicalSnapshot(entry.result);
    if (
      snapshot.digest !== row.snapshot_digest_sha256
      || snapshot.byteLength !== row.snapshot_byte_length
    ) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "security_discovery_snapshot_digest_mismatch");
    }
    return clone(entry);
  }

  async getForPrincipal(discoveryId: string, principalRef: string): Promise<StoredSecurityDiscovery | undefined> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(principalRef)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "security_discovery_principal_invalid");
    }
    const entry = await this.get(discoveryId);
    if (!entry || entry.principalRef !== principalRef) return undefined;
    return entry;
  }
}
