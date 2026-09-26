import "server-only";
import type { QueryExecutor } from "./db";
import { ProductContextRepository } from "./context";
import { UserPreferencesRepository } from "./preferences";
import { ProductUserRepository } from "./users";
import { PrincipalMappingRepository } from "../principal/repository";
import { ProviderRepository } from "../provider/repository";

export class ProductDataRepository {
  readonly users: ProductUserRepository;
  readonly context: ProductContextRepository;
  readonly preferences: UserPreferencesRepository;
  readonly principalMappings: PrincipalMappingRepository;
  readonly providers: ProviderRepository;

  constructor(db: QueryExecutor) {
    this.users = new ProductUserRepository(db);
    this.context = new ProductContextRepository(db);
    this.preferences = new UserPreferencesRepository(db);
    this.principalMappings = new PrincipalMappingRepository(db);
    this.providers = new ProviderRepository(db);
  }
}
