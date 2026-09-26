"use client";
import { identityCopy, type IdentityState, type PrincipalStatus } from "../lib/identity/contracts";
import { Badge, LoadingState } from "./primitives";
import { useIdentity } from "./identity-provider";
export function IdentityStateView({ state }: { state: IdentityState }) {
  return <div className="state" role="status"><Badge tone={state.kind === "forbidden" || state.kind === "revoked" ? "destructive" : state.kind === "expiring" || state.kind === "stale" || state.kind === "workspace_conflict" ? "attention" : "neutral"}>{state.kind.replaceAll("_", " ")}</Badge><p>{identityCopy[state.kind]}</p></div>;
}
export const principalCopy: Record<PrincipalStatus, string> = {
  mapped: "Principal mapped. Current grants and runtime preconditions are still checked by the server.",
  unmapped: "Principal unmapped. Product identity alone provides no operational access.",
  unavailable: "Principal mapping unavailable. Operational eligibility is unknown.",
  forbidden: "Principal forbidden. Product roles cannot override this denial.",
};
export function PrincipalStateView({ status }: { status: PrincipalStatus }) { return <div className="permission"><Badge tone={status === "forbidden" ? "destructive" : "neutral"}>Principal {status}</Badge><p>{principalCopy[status]}</p></div>; }
export function IdentityFeedback() {
  const { state, pending } = useIdentity();
  return pending ? <LoadingState label={pending === "workspace" ? "Switching workspace" : pending === "logout" ? "Signing out" : pending === "login" ? "Requesting sign-in redirect" : "Checking session"} /> : <IdentityStateView state={state} />;
}
