import "server-only";
import type { Pool } from "pg";
import { createProductPool } from "./db";
import { ProductDataRepository } from "./repository";

declare global {
  var __qgProductPool: Pool | undefined;
  var __qgProductDataRepository: ProductDataRepository | undefined;
}

export function productPool(): Pool {
  if (!globalThis.__qgProductPool) globalThis.__qgProductPool = createProductPool();
  return globalThis.__qgProductPool;
}

export function productDataRepository(): ProductDataRepository {
  if (!globalThis.__qgProductDataRepository) {
    globalThis.__qgProductDataRepository = new ProductDataRepository(productPool());
  }
  return globalThis.__qgProductDataRepository;
}
