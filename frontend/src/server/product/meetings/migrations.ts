import "server-only";
import path from "node:path";
import { ProductDataError } from "../data/errors";
import { readSourceMigrations, type SourceMigration } from "../data/migrations";
import { readProductMigrationsThroughBe5 } from "../collaboration/migrations";

export async function readProductMigrationsThroughBe7(): Promise<SourceMigration[]> {
  const [accepted, meetings] = await Promise.all([
    readProductMigrationsThroughBe5(),
    readSourceMigrations(path.join(process.cwd(), "src/server/product/meetings/migrations")),
  ]);
  const all = [...accepted, ...meetings].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const migration of all) {
    if (seen.has(migration.version)) throw new ProductDataError("PRODUCT_DATA_INVALID", "migration_version_invalid");
    seen.add(migration.version);
  }
  return all;
}
