import "server-only";
import { createHash } from "node:crypto";
import type { ProductContextAdapter } from "../adapters/workspace";
import { PostgresProductContextAdapter } from "../adapters/postgres-context";
import type { PrincipalMappingAdapter } from "../principal/adapter";
import { PostgresPrincipalMappingAdapter } from "../principal/adapter";
import { productDataRepository } from "../data/runtime";
import type { ProductSession } from "../identity/types";
import { discoverSecurityStack } from "./discovery";
import { createSecurityAssessmentPlan } from "./planner";
import type { SecurityDiscoveryStore } from "./store";
import { MemorySecurityDiscoveryStore } from "./store";
import type { SecuritySourceAdapter } from "./source";
import { UnavailableSecuritySourceAdapter } from "./source";
import type { SecurityAssessmentPlan, SecurityDiscoveryRequest, SecurityDiscoveryResult, StoredSecurityDiscovery } from "./types";

interface EligibleSecurityContext {
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  principalRef: string;
}

function assertDiscoveryId(discoveryId: string): void {
  if (!/^disc_[0-9a-f]{24}$/.test(discoveryId)) throw new Error("security_discovery_id_invalid");
}

function scopeDiscoveryId(context: EligibleSecurityContext, discovery: SecurityDiscoveryResult): string {
  const digest = createHash("sha256").update(JSON.stringify({
    productUserId: context.productUserId,
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    principalRef: context.principalRef,
    sourceDiscoveryId: discovery.discoveryId,
  })).digest("hex").slice(0, 24);
  return `disc_${digest}`;
}

export class SecurityAssessmentService {
  constructor(
    private readonly context: ProductContextAdapter = new PostgresProductContextAdapter(productDataRepository()),
    private readonly principalMappings: PrincipalMappingAdapter = new PostgresPrincipalMappingAdapter(productDataRepository()),
    private readonly sources: SecuritySourceAdapter = new UnavailableSecuritySourceAdapter(),
    private readonly discoveries: SecurityDiscoveryStore = new MemorySecurityDiscoveryStore(),
  ) {}

  private async eligible(session: ProductSession): Promise<EligibleSecurityContext> {
    if (!session.workspace) throw new Error("security_workspace_required");

    const workspace = await this.context.workspaceForUser(session.identity.userRef, session.workspace.id);
    if (!workspace || workspace.organizationId !== session.workspace.organizationId) throw new Error("security_forbidden");

    if (session.principalMapping.state !== "mapped-reference") {
      if (session.principalMapping.state === "unavailable") throw new Error("security_principal_unavailable");
      throw new Error("security_forbidden");
    }

    const resolved = await this.principalMappings.resolve({
      productUserId: session.identity.userRef,
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      correlationId: session.correlationId,
      expectedMappingVersion: session.principalMapping.mappingVersion,
    });

    if (resolved.state === "unavailable") throw new Error("security_principal_unavailable");
    if (resolved.state !== "mapped-reference") throw new Error("security_forbidden");
    if (resolved.principalRef !== session.principalMapping.principalRef || resolved.mappingVersion !== session.principalMapping.mappingVersion) {
      throw new Error("security_forbidden");
    }

    return {
      productUserId: session.identity.userRef,
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      principalRef: resolved.principalRef,
    };
  }

  private assertOwnedDiscovery(context: EligibleSecurityContext, entry: StoredSecurityDiscovery | undefined): StoredSecurityDiscovery {
    if (!entry) throw new Error("security_discovery_not_found");
    if (
      entry.productUserId !== context.productUserId ||
      entry.organizationId !== context.organizationId ||
      entry.workspaceId !== context.workspaceId ||
      entry.principalRef !== context.principalRef
    ) {
      throw new Error("security_forbidden");
    }
    return entry;
  }

  async discover(session: ProductSession, request: SecurityDiscoveryRequest): Promise<SecurityDiscoveryResult> {
    const eligible = await this.eligible(session);
    const snapshot = await this.sources.resolve({
      ...eligible,
      projectId: request.projectId,
      ...(request.targetId ? { targetId: request.targetId } : {}),
    });

    if (snapshot.projectId !== request.projectId) throw new Error("security_project_forbidden");
    if ((request.targetId ?? undefined) !== (snapshot.targetId ?? undefined)) throw new Error("security_target_forbidden");

    const discovered = discoverSecurityStack(snapshot);
    const result = { ...discovered, discoveryId: scopeDiscoveryId(eligible, discovered) };
    this.discoveries.put({ ...eligible, result });
    return result;
  }

  async result(session: ProductSession, discoveryId: string): Promise<SecurityDiscoveryResult> {
    assertDiscoveryId(discoveryId);
    const eligible = await this.eligible(session);
    return this.assertOwnedDiscovery(eligible, this.discoveries.get(discoveryId)).result;
  }

  async createPlan(session: ProductSession, discoveryId: string): Promise<SecurityAssessmentPlan> {
    assertDiscoveryId(discoveryId);
    const eligible = await this.eligible(session);
    const entry = this.assertOwnedDiscovery(eligible, this.discoveries.get(discoveryId));
    return createSecurityAssessmentPlan(entry.result);
  }
}
