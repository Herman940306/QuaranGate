import "server-only";
import type { StoredSecurityDiscovery } from "./types";

export interface SecurityDiscoveryStore {
  put(entry: StoredSecurityDiscovery): void;
  get(discoveryId: string): StoredSecurityDiscovery | undefined;
}

export class MemorySecurityDiscoveryStore implements SecurityDiscoveryStore {
  private readonly entries = new Map<string, StoredSecurityDiscovery>();

  constructor(private readonly maxEntries = 256) {}

  put(entry: StoredSecurityDiscovery): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(entry.result.discoveryId)) {
      const first = this.entries.keys().next().value as string | undefined;
      if (first) this.entries.delete(first);
    }
    this.entries.set(entry.result.discoveryId, entry);
  }

  get(discoveryId: string): StoredSecurityDiscovery | undefined {
    return this.entries.get(discoveryId);
  }
}
