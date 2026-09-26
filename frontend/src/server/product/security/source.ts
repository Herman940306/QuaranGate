import "server-only";
import type { SecuritySourceResolveContext, TrustedSecuritySourceSnapshot } from "./types";

export interface SecuritySourceAdapter {
  resolve(context: SecuritySourceResolveContext): Promise<TrustedSecuritySourceSnapshot>;
}

export class UnavailableSecuritySourceAdapter implements SecuritySourceAdapter {
  async resolve(_context: SecuritySourceResolveContext): Promise<TrustedSecuritySourceSnapshot> {
    throw new Error("security_source_unavailable");
  }
}
