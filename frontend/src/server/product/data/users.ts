import "server-only";
import { randomUUID } from "node:crypto";
import type { QueryExecutor } from "./db";
import { ProductDataError } from "./errors";
import type { ProductUserRow } from "./rows";
import { isoTimestamp } from "./rows";
import type { ProductUserRecord } from "./types";

export interface VerifiedProductIdentity {
  issuer: string;
  subject: string;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
}

function mapUser(row: ProductUserRow): ProductUserRecord {
  return {
    id: row.id,
    issuer: row.keycloak_issuer,
    subject: row.keycloak_subject,
    displayName: row.display_name ?? undefined,
    email: row.email ?? undefined,
    emailVerified: row.email_verified ?? undefined,
    status: row.status,
    version: Number(row.version),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

export class ProductUserRepository {
  constructor(private readonly db: QueryExecutor) {}

  async findOrCreateByIdentity(identity: VerifiedProductIdentity): Promise<ProductUserRecord> {
    const inserted = await this.db.query<ProductUserRow>(
      `INSERT INTO product_users(
        id, keycloak_issuer, keycloak_subject, display_name, email, email_verified
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (keycloak_issuer, keycloak_subject) DO NOTHING
      RETURNING *`,
      [
        randomUUID(),
        identity.issuer,
        identity.subject,
        identity.displayName ?? null,
        identity.email ?? null,
        identity.emailVerified ?? null,
      ],
    );
    if (inserted.rows[0]) return mapUser(inserted.rows[0]);

    const existing = await this.db.query<ProductUserRow>(
      `SELECT * FROM product_users
       WHERE keycloak_issuer = $1 AND keycloak_subject = $2
       LIMIT 1`,
      [identity.issuer, identity.subject],
    );
    const user = existing.rows[0];
    if (!user) throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "product_user_resolution_failed");

    const changed =
      user.display_name !== (identity.displayName ?? null) ||
      user.email !== (identity.email ?? null) ||
      user.email_verified !== (identity.emailVerified ?? null);

    if (!changed) return mapUser(user);

    const updated = await this.db.query<ProductUserRow>(
      `UPDATE product_users
       SET display_name = $1,
           email = $2,
           email_verified = $3,
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND version = $5
       RETURNING *`,
      [identity.displayName ?? null, identity.email ?? null, identity.emailVerified ?? null, user.id, Number(user.version)],
    );
    return mapUser(updated.rows[0] ?? user);
  }
}
