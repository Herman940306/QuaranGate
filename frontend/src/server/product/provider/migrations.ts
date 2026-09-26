import "server-only";
import path from "node:path";
import { readAllProductMigrations, readSourceMigrations, type SourceMigration } from "../data/migrations";
import { ProductDataError } from "../data/errors";
export async function readProductMigrationsThroughBe4():Promise<SourceMigration[]>{
 const [accepted,providers]=await Promise.all([readAllProductMigrations(),readSourceMigrations(path.join(process.cwd(),"src/server/product/provider/migrations"))]);
 const all=[...accepted,...providers].sort((a,b)=>a.version-b.version);const seen=new Set<number>();
 for(const m of all){if(seen.has(m.version))throw new ProductDataError("PRODUCT_DATA_INVALID","migration_version_invalid");seen.add(m.version);}
 return all;
}