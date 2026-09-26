"use client";
import type { SessionView } from "../lib/identity/contracts";
import { useIdentity } from "./identity-provider";
import { IdentityFeedback, PrincipalStateView } from "./identity-status";
import { MetadataTable } from "./operational-read";
import { Badge, Panel } from "./primitives";
export const permissionBoundary = "Product roles and overrides determine workflow eligibility only. QuaranGate Principal grants remain separate. UI visibility is for usability; the server re-authorizes every operation against current grants and live resource preconditions.";
export function ProductAuthorization({ session, showPrincipal = true }: { session: SessionView; showPrincipal?: boolean }) {
  return <><p>{permissionBoundary}</p><MetadataTable caption="Read-only product authorization summary" rows={[
    { label: "Product roles", value: session.roles.join(" · ") || "No roles returned" },
    { label: "Product overrides", value: session.overrides.join(" · ") || "No overrides returned" },
    { label: "Server-returned capability summary (display only)", value: session.capabilitySummary.join(" · ") || "Not provided; eligibility unknown" },
  ]} />{showPrincipal ? <PrincipalStateView status={session.principal.status} /> : null}</>;
}
export function Permissions() {
  const { state } = useIdentity();
  const session = state.kind === "active" || state.kind === "expiring" ? state.session : undefined;
  return <><div className="page-heading"><div><p className="eyebrow">PRODUCT IDENTITY / AUTHORIZATION</p><h1>Product permissions</h1><p className="page-intro">Workflow eligibility and operational authority remain separate.</p></div><Badge>Read only</Badge></div><Panel title="Authorization boundary">{session ? <ProductAuthorization session={session} /> : <><p>{permissionBoundary}</p><IdentityFeedback /></>}</Panel></>;
}
