"use client";
import { createContext, useContext, type ReactNode } from "react";
import { createProductClient } from "../lib/client/product/client";
import type { ProductClient, ProductContext } from "../lib/client/product/contracts";
import { useIdentity } from "./identity-provider";
const defaultClient = createProductClient();
const Client = createContext<ProductClient>(defaultClient);
export function ProductClientProvider({ client, children }: { client: ProductClient; children: ReactNode }) { return <Client value={client}>{children}</Client>; }
export function ProductBoundary({ children }: { children: (client: ProductClient, context: ProductContext | undefined) => ReactNode }) {
  const client = useContext(Client); const identity = useIdentity(); const s = identity.state;
  const context = s.kind === "active" || s.kind === "expiring" ? { userId: s.session.user.id, organizationId: s.session.organization.id, workspaceId: s.session.workspace.id, sessionVersion: s.session.version } : undefined;
  // Synchronous render boundary: stale fields/results vanish before effects or late promises run.
  return <ProductEpoch key={identity.projectionEpoch}>{children(client, context)}</ProductEpoch>;
}
function ProductEpoch({ children }: { children: ReactNode }) { return children; }
