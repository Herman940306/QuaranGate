import { OperationalError } from "./state";
import { record } from "./transport";
import { text } from "./contracts";
import { toolCatalog } from "./tool-catalog";
export interface DiscoveredTool { name: string; fields: Array<{ name: string; required: boolean; type: string; min: number | null; max: number | null }> }
export function discoveryPage(value: unknown): { tools: DiscoveredTool[]; nextCursor?: string } {
  const data = record(value);
  if (!Array.isArray(data.tools) || data.tools.length > 1000) throw new OperationalError("unknown");
  const tools = data.tools.map(value => {
    const row = record(value); const name = text(row.name, 128);
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new OperationalError("unknown");
    const schema = row.inputSchema == null ? null : record(row.inputSchema);
    const properties = schema?.properties == null ? {} : record(schema.properties);
    if (Object.keys(properties).length > 64) throw new OperationalError("unknown");
    const required = schema?.required ?? [];
    if (!Array.isArray(required) || required.length > 64 || required.some(key => typeof key !== "string" || !Object.hasOwn(properties, key))) throw new OperationalError("unknown");
    const fields = Object.entries(properties).map(([name,value]) => {
      if (name.length > 64 || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) throw new OperationalError("unknown");
      const property = record(value);
      const bound = (key: string): number | null => property[key] == null ? null : typeof property[key] === "number" && Number.isFinite(property[key]) && property[key] >= 0 ? property[key] : (() => { throw new OperationalError("unknown"); })();
      const type = ["string", "number", "integer", "boolean", "array", "object"].includes(String(property.type)) ? String(property.type) : "UNKNOWN";
      return { name, required: required.includes(name), type, min: bound(type === "string" ? "minLength" : "minimum"), max: bound(type === "string" ? "maxLength" : "maximum") };
    });
    return { name, fields };
  });
  return { tools, nextCursor: data.nextCursor == null ? undefined : text(data.nextCursor, 512) };
}
export function compareTools(tools: readonly DiscoveredTool[]) {
  const actual = new Set(tools.map(tool => tool.name));
  if (actual.size !== tools.length) throw new OperationalError("unknown");
  const expected = new Set<string>(toolCatalog.map(tool => tool.name));
  return { expected: expected.size, live: actual.size, missing: [...expected].filter(name => !actual.has(name)).sort(), extra: [...actual].filter(name => !expected.has(name)).sort() };
}
