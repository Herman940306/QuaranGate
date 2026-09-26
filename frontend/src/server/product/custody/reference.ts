import "server-only";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CUSTODY_REF = /^qg\/product\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/v[0-9]+$/;

export function custodyReference(organizationId: string, workspaceId: string, providerId: string, version: number): string {
  if (![organizationId, workspaceId, providerId].every((value) => UUID.test(value))) throw new Error("provider_custody_identity_invalid");
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("provider_custody_version_invalid");
  return `qg/product/${organizationId.toLowerCase()}/${workspaceId.toLowerCase()}/${providerId.toLowerCase()}/v${version}`;
}

export function assertCustodyReference(reference: string): void {
  if (!CUSTODY_REF.test(reference)) throw new Error("provider_custody_reference_invalid");
}
