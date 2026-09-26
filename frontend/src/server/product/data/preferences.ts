import "server-only";
import type { QueryExecutor } from "./db";
import { ProductDataError } from "./errors";
import type { PreferenceRow } from "./rows";
import { isoTimestamp } from "./rows";
import type { PreferenceUpdate, UserPreferencesRecord } from "./types";

function mapPreferences(row: PreferenceRow): UserPreferencesRecord {
  return {
    productUserId: row.product_user_id,
    appearanceMode: row.appearance_mode,
    palette: row.palette,
    density: row.density,
    version: Number(row.version),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

export class UserPreferencesRepository {
  constructor(private readonly db: QueryExecutor) {}

  async read(productUserId: string): Promise<UserPreferencesRecord> {
    await this.db.query(
      `INSERT INTO user_preferences(product_user_id)
       VALUES ($1)
       ON CONFLICT (product_user_id) DO NOTHING`,
      [productUserId],
    );
    const result = await this.db.query<PreferenceRow>(
      "SELECT * FROM user_preferences WHERE product_user_id = $1",
      [productUserId],
    );
    const row = result.rows[0];
    if (!row) throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "preferences_not_found");
    return mapPreferences(row);
  }

  async update(productUserId: string, update: PreferenceUpdate): Promise<UserPreferencesRecord> {
    const result = await this.db.query<PreferenceRow>(
      `UPDATE user_preferences
       SET appearance_mode = $1,
           palette = $2,
           density = $3,
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE product_user_id = $4 AND version = $5
       RETURNING *`,
      [update.appearanceMode, update.palette, update.density, productUserId, update.expectedVersion],
    );
    const row = result.rows[0];
    if (!row) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "preferences_stale_version");
    return mapPreferences(row);
  }
}
