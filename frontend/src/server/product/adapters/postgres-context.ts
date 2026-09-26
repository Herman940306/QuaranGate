import "server-only";
import type { SafeProductIdentity } from "../identity/types";
import type { ProductContextAdapter } from "./workspace";
import type { ProductDataRepository } from "../data/repository";

export class PostgresProductContextAdapter implements ProductContextAdapter {
  constructor(private readonly data: ProductDataRepository) {}

  async resolveIdentity(issuer: string, identity: SafeProductIdentity): Promise<SafeProductIdentity> {
    const user = await this.data.users.findOrCreateByIdentity({
      issuer,
      subject: identity.subject,
      displayName: identity.displayName,
      email: identity.email,
      emailVerified: identity.emailVerified,
    });
    return { ...identity, userRef: user.id };
  }

  async workspaceForUser(userRef: string, workspaceId: string) {
    const workspace = await this.data.context.resolveWorkspaceMembership(userRef, workspaceId);
    if (!workspace) return undefined;
    return {
      id: workspace.id,
      organizationId: workspace.organizationId,
      name: workspace.name,
    };
  }
}
