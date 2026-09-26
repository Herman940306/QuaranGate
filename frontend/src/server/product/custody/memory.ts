import "server-only";
import { assertCustodyReference } from "./reference";
import type { CustodyAvailability, SecretCustody } from "./types";

export class TestMemorySecretCustody implements SecretCustody {
  private readonly values = new Map<string, string>();
  constructor(private readonly state: CustodyAvailability = "available") {
    if (process.env.NODE_ENV !== "test") throw new Error("test_secret_custody_denied");
  }
  async availability(): Promise<CustodyAvailability> { return this.state; }
  async store(reference: string, secret: string): Promise<void> {
    assertCustodyReference(reference);
    if (this.state !== "available") throw new Error("secret_custody_unavailable");
    if (!secret || secret.length > 16_384) throw new Error("provider_secret_invalid");
    this.values.set(reference, secret);
  }
  async resolve<T>(reference: string, use: (secret: string) => Promise<T>): Promise<T> {
    assertCustodyReference(reference);
    if (this.state !== "available") throw new Error("secret_custody_unavailable");
    const secret = this.values.get(reference);
    if (!secret) throw new Error("secret_custody_unavailable");
    return use(secret);
  }
  async delete(reference: string): Promise<void> {
    assertCustodyReference(reference);
    if (this.state !== "available") throw new Error("secret_custody_unavailable");
    this.values.delete(reference);
  }
}
