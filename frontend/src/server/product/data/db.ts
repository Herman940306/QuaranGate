import "server-only";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { ProductDataError } from "./errors";

export interface QueryResultLike<T> {
  rows: T[];
  rowCount: number | null;
}

export interface QueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResultLike<T>>;
}

export interface TransactionPool extends QueryExecutor {
  connect(): Promise<PoolClient>;
}

function databaseUrl(): string {
  const value = process.env.QG_PRODUCT_DATABASE_URL?.trim();
  if (!value) throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "product_database_not_configured");
  const parsed = new URL(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "product_database_url_invalid");
  }
  return value;
}

export function createProductPool(): Pool {
  return new Pool({
    connectionString: databaseUrl(),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "quarangate-product",
  });
}

export async function withTransaction<T>(pool: TransactionPool, work: (client: QueryExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  } finally {
    client.release();
  }
}
