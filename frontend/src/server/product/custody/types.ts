import "server-only";

export type CustodyAvailability = "available" | "unavailable" | "forbidden";

export interface SecretCustody {
  availability(): Promise<CustodyAvailability>;
  store(reference: string, secret: string): Promise<void>;
  resolve<T>(reference: string, use: (secret: string) => Promise<T>): Promise<T>;
  delete(reference: string): Promise<void>;
}
