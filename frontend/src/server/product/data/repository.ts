import "server-only";
import type { QueryExecutor } from "./db";
import { ProductContextRepository } from "./context";
import { UserPreferencesRepository } from "./preferences";
import { ProductUserRepository } from "./users";
import { PrincipalMappingRepository } from "../principal/repository";

export class ProductDataRepository {
  readonly users: ProductUserRepository;
  readonly context: ProductContextRepository;
  readonly preferences: UserPreferencesRepository;
  readonly principalMappings: PrincipalMappingRepository;

  constructor(db: QueryExecutor) {
    this.users = new ProductUserRepository(db);
    this.context = new ProductContextRepository(db);
    this.preferences = new UserPreferencesRepository(db);
    this.principalMappings = new PrincipalMappingRepository(db);
  }
}
