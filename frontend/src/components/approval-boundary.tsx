"use client";
import { createContext, useContext, type ReactNode } from "react";
import { createApprovalClient } from "../lib/client/approvals/client";
import type { ApprovalClient } from "../lib/client/approvals/contracts";
import type { ProductContext } from "../lib/client/product/contracts";
import { useIdentity } from "./identity-provider";

const defaultClient = createApprovalClient();
const Client = createContext<ApprovalClient>(defaultClient);

export function ApprovalClientProvider({ client, children }: { client: ApprovalClient; children: ReactNode }) {
  return <Client value={client}>{children}</Client>;
}

export function ApprovalBoundary({ children }: { children: (client: ApprovalClient, context: ProductContext | undefined) => ReactNode }) {
  const client = useContext(Client);
  const identity = useIdentity();
  const state = identity.state;
  const context = state.kind === "active" || state.kind === "expiring"
    ? { userId: state.session.user.id, organizationId: state.session.organization.id, workspaceId: state.session.workspace.id, sessionVersion: state.session.version }
    : undefined;
  return <ApprovalEpoch key={identity.projectionEpoch}>{children(client, context)}</ApprovalEpoch>;
}
function ApprovalEpoch({ children }: { children: ReactNode }) { return children; }
