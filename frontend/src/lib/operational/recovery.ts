import { text } from "./contracts";
import { OperationalError } from "./state";
import { record } from "./transport";
export interface ResourceBoundary { generatedAt: string; state: string; ownership: string; cleanup: string; note: string }
export function resources(value: Record<string, unknown>): ResourceBoundary {
  if (value.view !== "resources") throw new OperationalError("unknown");
  const data = record(value.data);
  const field = (key: string) => data[key] == null ? "UNKNOWN" : text(data[key], 1024);
  return { generatedAt: text(value.generatedAt, 64), state: field("state"), ownership: field("ownershipModel"), cleanup: field("cleanupAuthority"), note: field("note") };
}
