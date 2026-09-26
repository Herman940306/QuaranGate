import "server-only";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { QueryExecutor, TransactionPool } from "./db";
import { withTransaction } from "./db";
import { ProductDataError } from "./errors";

export interface SourceMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function readSourceMigrations(directory = path.join(process.cwd(), "src/server/product/data/migrations")): Promise<SourceMigration[]> {
  const entries = (await readdir(directory)).filter((name) => MIGRATION_FILE.test(name)).sort();
  const migrations = await Promise.all(entries.map(async (name) => {
    const match = MIGRATION_FILE.exec(name);
    if (!match) throw new ProductDataError("PRODUCT_DATA_INVALID", "migration_name_invalid");
    const sql = await readFile(path.join(directory, name), "utf8");
    return {
      version: Number(match[1]),
      name,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  }));
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0 || versions.has(migration.version)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "migration_version_invalid");
    }
    versions.add(migration.version);
  }
  return migrations;
}

async function ensureRegistry(executor: QueryExecutor): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS product_schema_migrations (
      version bigint PRIMARY KEY CHECK (version > 0),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
      checksum_sha256 char(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export async function runMigrations(pool: TransactionPool, migrations: SourceMigration[]): Promise<void> {
  await ensureRegistry(pool);
  for (const migration of migrations) {
    const existing = await pool.query<{ checksum_sha256: string }>(
      "SELECT checksum_sha256 FROM product_schema_migrations WHERE version = $1",
      [migration.version],
    );
    if (existing.rowCount) {
      if (existing.rows[0]?.checksum_sha256 !== migration.checksum) {
        throw new ProductDataError("PRODUCT_DATA_INVALID", "migration_checksum_mismatch");
      }
      continue;
    }

    await withTransaction(pool, async (client) => {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO product_schema_migrations(version, name, checksum_sha256) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migration.checksum],
      );
    });
  }
}
