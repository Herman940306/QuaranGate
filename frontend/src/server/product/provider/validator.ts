import "server-only";
import type { ProviderKind, ProviderValidationStatus } from "./types";
export interface ProviderValidationResult { status: ProviderValidationStatus; code?: string; }
export interface ProviderValidator { validate(kind: ProviderKind, secret: string): Promise<ProviderValidationResult>; }
export class UnavailableProviderValidator implements ProviderValidator {
  async validate(_kind: ProviderKind, _secret: string): Promise<ProviderValidationResult> { return { status: "unavailable", code: "provider_validation_unavailable" }; }
}
export class TestProviderValidator implements ProviderValidator {
  constructor(private readonly result: ProviderValidationResult={status:"valid"}) { if(process.env.NODE_ENV!=="test") throw new Error("test_provider_validator_denied"); }
  async validate(_kind:ProviderKind,_secret:string):Promise<ProviderValidationResult>{return this.result;}
}