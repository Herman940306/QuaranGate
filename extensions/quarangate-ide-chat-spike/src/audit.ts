export type InvocationOrigin = "human" | "machine";
export type OperationState = "started" | "chunk" | "completed" | "cancelled" | "error";

export type AuditRecord = Readonly<{
  operationId: string;
  origin: InvocationOrigin;
  state: OperationState;
  sequence: number;
  workspaceFingerprint: string;
}>;

export interface AuditLogger {
  record(entry: AuditRecord): void;
}

export class MemoryAuditLogger implements AuditLogger {
  public readonly entries: AuditRecord[] = [];

  public record(entry: AuditRecord): void {
    this.entries.push({ ...entry });
  }
}
