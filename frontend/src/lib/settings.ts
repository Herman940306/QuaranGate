import type { IdentityState } from "./identity/contracts";
import type { MetadataRow } from "./operational/contracts";
export function settingsIdentity(state: IdentityState): MetadataRow[] {
  const session = state.kind === "active" || state.kind === "expiring" ? state.session : undefined;
  return [
    { label: "Session state", value: state.kind },
    { label: "Product identity", value: session?.user.displayName ?? "NOT_AVAILABLE" },
    { label: "Workspace", value: session?.workspace.name ?? "UNKNOWN" },
    { label: "Principal mapping", value: session?.principal.status ?? "UNKNOWN" },
    { label: "Principal reference", value: session?.principal.reference ?? "UNKNOWN" },
  ];
}
