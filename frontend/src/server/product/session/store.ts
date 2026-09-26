import "server-only";
import { randomBytes } from "node:crypto";
import { assertMemoryAdapterAllowed } from "../auth/config";
import type { LoginTransaction, ProductSession } from "../identity/types";

export interface ProductSessionStore {
  createSession(value: Omit<ProductSession, "id">): ProductSession;
  getSession(id: string, now?: number): ProductSession | undefined;
  replaceSession(session: ProductSession): void;
  revokeSession(id: string): ProductSession | undefined;
  createTransaction(value: Omit<LoginTransaction, "id">): LoginTransaction;
  consumeTransaction(id: string, now?: number): LoginTransaction | undefined;
}

export function opaqueId(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export class MemoryProductSessionStore implements ProductSessionStore {
  private readonly sessions = new Map<string, ProductSession>();
  private readonly transactions = new Map<string, LoginTransaction>();

  constructor() {
    assertMemoryAdapterAllowed();
  }

  createSession(value: Omit<ProductSession, "id">): ProductSession {
    const session = { ...value, id: opaqueId() };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string, now = Date.now()): ProductSession | undefined {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= now) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  replaceSession(session: ProductSession): void {
    if (!this.sessions.has(session.id)) throw new Error("product_session_missing");
    this.sessions.set(session.id, session);
  }

  revokeSession(id: string): ProductSession | undefined {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    return session;
  }

  createTransaction(value: Omit<LoginTransaction, "id">): LoginTransaction {
    const transaction = { ...value, id: opaqueId() };
    this.transactions.set(transaction.id, transaction);
    return transaction;
  }

  consumeTransaction(id: string, now = Date.now()): LoginTransaction | undefined {
    const transaction = this.transactions.get(id);
    this.transactions.delete(id);
    if (!transaction || transaction.expiresAt <= now) return undefined;
    return transaction;
  }
}
