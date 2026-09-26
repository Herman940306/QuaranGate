import "server-only";
import path from "node:path";
import { ProductDataError } from "../data/errors";
import { readSourceMigrations, type SourceMigration } from "../data/migrations";
import { readProductMigrationsThroughBe4 } from "../provider/migrations";

export async function readProductMigrationsThroughBe5(): Promise<SourceMigration[]> {
  const [accepted, collaboration] = await Promise.all([
    readProductMigrationsThroughBe4(),
    readSourceMigrations(path.join(process.cwd(), "src/server/product/collaboration/migrations")),
  ]);
  const all = [...accepted, ...collaboration].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const migration of all) {
    if (seen.has(migration.version)) throw new ProductDataError("PRODUCT_DATA_INVALID", "migration_version_invalid");
    seen.add(migration.version);
  }
  return all;
}
