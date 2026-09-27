import "server-only";
import path from "node:path";
import { ProductDataError } from "../data/errors";
import { readSourceMigrations, type SourceMigration } from "../data/migrations";
import { readProductMigrationsThroughBe7 } from "../meetings/migrations";

export async function readProductMigrationsThroughBe9(): Promise<SourceMigration[]> {
  const [accepted, security] = await Promise.all([
    readProductMigrationsThroughBe7(),
    readSourceMigrations(path.join(process.cwd(), "src/server/product/security/migrations")),
  ]);
  const all = [...accepted, ...security].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const migration of all) {
    if (seen.has(migration.version)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "migration_version_invalid");
    }
    seen.add(migration.version);
  }
  return all;
}
