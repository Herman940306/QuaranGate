import "server-only";
import type { QueryExecutor } from "./db";
import { ProductContextRepository } from "./context";
import { UserPreferencesRepository } from "./preferences";
import { ProductUserRepository } from "./users";

export class ProductDataRepository {
  readonly users: ProductUserRepository;
  readonly context: ProductContextRepository;
  readonly preferences: UserPreferencesRepository;

  constructor(db: QueryExecutor) {
    this.users = new ProductUserRepository(db);
    this.context = new ProductContextRepository(db);
    this.preferences = new UserPreferencesRepository(db);
  }
}
