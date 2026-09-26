import "server-only";
import type { ProductWorkspace, SafeProductIdentity } from "../identity/types";

export interface ProductContextAdapter {
  resolveIdentity(issuer: string, identity: SafeProductIdentity): Promise<SafeProductIdentity>;
  workspaceForUser(userRef: string, workspaceId: string): Promise<ProductWorkspace | undefined>;
}

export class NonDurableProductContextAdapter implements ProductContextAdapter {
  private readonly memberships = new Map<string, ProductWorkspace[]>();

  constructor() {
    if (process.env.NODE_ENV === "production") throw new Error("product_context_non_durable_production_denied");
  }

  seedForTests(userRef: string, workspaces: ProductWorkspace[]): void {
    this.memberships.set(userRef, workspaces);
  }

  async resolveIdentity(_issuer: string, identity: SafeProductIdentity): Promise<SafeProductIdentity> {
    return identity;
  }

  async workspaceForUser(userRef: string, workspaceId: string): Promise<ProductWorkspace | undefined> {
    return this.memberships.get(userRef)?.find((workspace) => workspace.id === workspaceId);
  }
}
