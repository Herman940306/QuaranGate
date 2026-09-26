import "server-only";
import type { ProductSession } from "../identity/types";
import { assertCsrf } from "../authority/csrf";
import type { PreferenceUpdate } from "./types";
import type { ProductDataRepository } from "./repository";

export class ProductDataService {
  constructor(private readonly data: ProductDataRepository) {}

  async listWorkspaces(productUserId: string) {
    return this.data.context.listVisibleWorkspaces(productUserId);
  }

  async readPreferences(productUserId: string) {
    return this.data.preferences.read(productUserId);
  }

  async updatePreferences(request: Request, session: ProductSession, update: PreferenceUpdate) {
    assertCsrf(request, session);
    return this.data.preferences.update(session.identity.userRef, update);
  }

  async effectiveRole(productUserId: string, workspaceId: string) {
    return this.data.context.effectiveProductRole(productUserId, workspaceId);
  }
}
