import "server-only";
import type { AuditSink } from "../audit/events";
import type { ProductDataRepository } from "../data/repository";
import type { PrincipalMappingState } from "../identity/types";

export interface PrincipalMappingContext {
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  correlationId: string;
  expectedMappingVersion?: number;
}

export interface PrincipalMappingAdapter {
  resolve(context: PrincipalMappingContext): Promise<PrincipalMappingState>;
}

export class UnmappedTestPrincipalMappingAdapter implements PrincipalMappingAdapter {
  constructor() {
    if (process.env.NODE_ENV !== "test") throw new Error("test_principal_mapping_adapter_denied");
  }

  async resolve(_context: PrincipalMappingContext): Promise<PrincipalMappingState> {
    return { state: "unmapped" };
  }
}

export class PostgresPrincipalMappingAdapter implements PrincipalMappingAdapter {
  constructor(
    private readonly data: ProductDataRepository,
    private readonly audit?: AuditSink,
  ) {}

  async resolve(context: PrincipalMappingContext): Promise<PrincipalMappingState> {
    let result: PrincipalMappingState;
    try {
      result = await this.data.principalMappings.resolve({
        productUserId: context.productUserId,
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        expectedMappingVersion: context.expectedMappingVersion,
      });
    } catch {
      result = { state: "unavailable" };
    }
    this.audit?.({
      event: "identity.principal_mapping_resolved",
      outcome: result.state === "mapped-reference" ? "allowed" : result.state === "unavailable" ? "error" : "denied",
      correlationId: context.correlationId,
      userRef: context.productUserId,
      workspaceId: context.workspaceId,
      reason: result.state,
      ...(result.state === "mapped-reference" ? { principalRef: result.principalRef } : {}),
    });
    return result;
  }
}
