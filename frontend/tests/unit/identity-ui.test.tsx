import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IdentityProvider } from "../../src/components/identity-provider";
import { SignIn } from "../../src/components/identity-sign-in";
import { IdentityStateView, PrincipalStateView, principalCopy } from "../../src/components/identity-status";
import { identityCopy, type IdentityState, type PrincipalStatus } from "../../src/lib/identity/contracts";
describe("safe identity surfaces", () => {
  it("sign-in collects no credentials and offers no fake login", () => { const html = renderToStaticMarkup(<IdentityProvider><SignIn /></IdentityProvider>); expect(html).toContain("Identity service not integrated yet"); expect(html).toContain("Continue to identity provider"); expect(html).toContain("disabled"); expect(html).not.toContain("<input"); expect(html).not.toContain("<form"); });
  it.each(Object.keys(identityCopy) as IdentityState["kind"][])("explicit %s state", kind => { expect(renderToStaticMarkup(<IdentityStateView state={{ kind } as IdentityState} />)).toContain(identityCopy[kind]); });
  it.each(Object.keys(principalCopy) as PrincipalStatus[])("explicit principal %s", status => { expect(renderToStaticMarkup(<PrincipalStateView status={status} />)).toContain(principalCopy[status]); });
});

import { AccountSession } from "../../src/components/identity-account";
it("safe account renders identity references, UTC times and principal status", () => {
  const html = renderToStaticMarkup(<AccountSession session={{ user: { id: "demo-user", displayName: "<script>synthetic</script>" }, organization: { id: "demo-org", name: "Synthetic organization" }, workspace: { id: "demo-workspace", name: "Synthetic workspace" }, workspaces: [], roles: [], overrides: [], capabilitySummary: [], principal: { status: "unmapped" }, version: "demo-version", issuedAt: "2026-09-26T08:00:00Z", expiresAt: "2026-09-26T09:00:00Z" }} />);
  expect(html).toContain("Synthetic organization"); expect(html).toContain("Expires (UTC)"); expect(html).toContain("Principal unmapped"); expect(html).not.toContain("<script>"); expect(html).not.toMatch(/token|claims|cookie/);
});

import { permissionBoundary, ProductAuthorization } from "../../src/components/identity-permissions";
it("product roles cannot grant principal authority; summaries are escaped display only", () => {
  const html = renderToStaticMarkup(<ProductAuthorization session={{ user: { id: "demo", displayName: "Synthetic" }, organization: { id: "demo-org", name: "Demo" }, workspace: { id: "demo-ws", name: "Demo" }, workspaces: [], roles: ["Administrator"], overrides: ["<script>synthetic</script>"], capabilitySummary: ["Workflow eligibility"], principal: { status: "forbidden" }, version: "demo", issuedAt: "2026-09-26T08:00:00Z", expiresAt: "2026-09-26T09:00:00Z" }} />);
  expect(html).toContain(permissionBoundary); expect(html).toContain("Principal forbidden"); expect(html).not.toContain("<script>"); expect(html).not.toMatch(/privilege score|authority tier/);
});
