import { OperationalError } from "./state";
export type Transport = (target: "/mcp", init: RequestInit) => Promise<Response>;
export interface JsonRpcRequest { jsonrpc: "2.0"; id: string; method: "tools/call"; params: { name: string; arguments: Record<string, unknown> } }
export type JsonRpcResponse = { jsonrpc: "2.0"; id: string; result: unknown } | { jsonrpc: "2.0"; id: string; error: { code: number; message: string; data?: unknown } };
export interface ReadReceipt<T> { data: T; receivedAt: string; correlationId?: string }
const RESPONSE_BYTES = 2 * 1024 * 1024;
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperationalError("unknown");
  return value as Record<string, unknown>;
}
function errorState(code: unknown) {
  if (code === "UNAUTHENTICATED") return "unauthenticated";
  if (typeof code === "string" && code.startsWith("FORBIDDEN")) return "forbidden";
  if (code === "NOT_IMPLEMENTED") return "not_implemented";
  if (code === "GITHUB_NOT_CONFIGURED" || code === "EXECUTOR_UNAVAILABLE") return "unavailable";
  return "unknown";
}
function correlation(response: Response) {
  const value = response.headers.get("X-QuaranGate-Request-Id");
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new OperationalError("unknown");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let output = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_BYTES) throw new OperationalError("unknown");
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function envelope(text: string, contentType: string, id: string): Record<string, unknown> {
  let value: unknown;
  if (contentType.includes("text/event-stream")) {
    const events = text.replace(/\r\n/g, "\n").split("\n\n").filter(event => event.split("\n").some(line => line.startsWith("data:")));
    const responses = events.map(event => JSON.parse(event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")) as unknown).filter(event => Object.hasOwn(record(event), "id"));
    if (responses.length !== 1) throw new OperationalError("unknown");
    value = responses[0];
  } else if (contentType.includes("application/json")) value = JSON.parse(text);
  else throw new OperationalError("unknown");
  const payload = record(value);
  if (payload.jsonrpc !== "2.0" || payload.id !== id || Object.hasOwn(payload, "result") === Object.hasOwn(payload, "error")) throw new OperationalError("unknown");
  return payload;
}
function toolData(result: unknown): Record<string, unknown> {
  const tool = record(result);
  if (tool.isError !== undefined && typeof tool.isError !== "boolean") throw new OperationalError("unknown");
  const data = tool.structuredContent !== undefined ? record(tool.structuredContent) : (() => {
    if (!Array.isArray(tool.content)) throw new OperationalError("unknown");
    const parts = tool.content.filter(part => part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
    if (parts.length !== 1) throw new OperationalError("unknown");
    return record(JSON.parse(parts[0].text));
  })();
  if (tool.isError === true) throw new OperationalError(errorState(data.error));
  return data;
}
// Internal module seam only. Product code uses the purpose-specific client, never a generic call.
const readTools = new Set(["targets_list", "target_inspect", "agent_projects", "agents_list", "agent_status", "agent_result", "agent_diff", "git_status", "git_diff", "git_log", "github_repositories", "github_repository", "github_branches", "github_commits", "github_pull_requests", "github_pull_request", "github_pull_request_files", "github_issues", "github_issue", "github_issue_comments", "github_pull_request_reviews", "github_pull_request_review_comments", "github_checks", "control_center_query", "fs_list", "fs_stat", "fs_read", "fs_search", "process_list"]);
const writeTools = new Set(["fs_write", "fs_patch", "fs_delete", "terminal_exec", "target_start", "target_stop", "target_restart", "agent_dispatch", "agent_cancel", "agent_apply", "agent_discard", "github_push_branch", "github_pull_request_create", "github_pull_request_update", "github_pull_request_review"]);
export type ReadTool = "targets_list" | "target_inspect" | "agent_projects" | "agents_list" | "agent_status" | "agent_result" | "agent_diff" | "git_status" | "git_diff" | "git_log" | "github_repositories" | "github_repository" | "github_branches" | "github_commits" | "github_pull_requests" | "github_pull_request" | "github_pull_request_files" | "github_issues" | "github_issue" | "github_issue_comments" | "github_pull_request_reviews" | "github_pull_request_review_comments" | "github_checks" | "control_center_query" | "fs_list" | "fs_stat" | "fs_read" | "fs_search" | "process_list";
export type WriteTool = "fs_write" | "fs_patch" | "fs_delete" | "terminal_exec" | "target_start" | "target_stop" | "target_restart" | "agent_dispatch" | "agent_cancel" | "agent_apply" | "agent_discard" | "github_push_branch" | "github_pull_request_create" | "github_pull_request_update" | "github_pull_request_review";
function createCaller(transport: Transport, allowed: Set<string>) {
  return async <T>(name: ReadTool | WriteTool, args: Record<string, unknown>, decode: (value: Record<string, unknown>) => T, signal?: AbortSignal): Promise<ReadReceipt<T>> => {
    const id = crypto.randomUUID();
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    let requestCorrelation: string | undefined;
    try {
      combined.throwIfAborted();
      if (!allowed.has(name)) throw new OperationalError("unknown");
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
      const response = await transport("/mcp", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(request), signal: combined }).catch(() => { throw new OperationalError("unavailable"); });
      requestCorrelation = correlation(response);
      if (!response.ok) throw new OperationalError(response.status === 401 ? "unauthenticated" : response.status === 403 ? "forbidden" : "unavailable");
      const payload = envelope(await boundedText(response), response.headers.get("content-type") ?? "", id);
      combined.throwIfAborted();
      if (Object.hasOwn(payload, "error")) {
        const error = record(payload.error);
        if (!Number.isInteger(error.code) || typeof error.message !== "string") throw new OperationalError("unknown");
        throw new OperationalError(errorState(error.data));
      }
      return { data: decode(toolData(payload.result)), receivedAt: new Date().toISOString(), correlationId: requestCorrelation };
    } catch (error) {
      if (signal?.aborted) throw new OperationalError("cancelled", requestCorrelation);
      if (combined.aborted) throw new OperationalError("unavailable", requestCorrelation);
      if (error instanceof OperationalError) throw new OperationalError(error.state, requestCorrelation);
      throw new OperationalError("unknown", requestCorrelation);
    }
  };
}
export function createReader(transport: Transport = (target, init) => fetch(target, init)) {
  const call = createCaller(transport, readTools);
  return <T>(name: ReadTool, args: Record<string, unknown>, decode: (value: Record<string, unknown>) => T, signal?: AbortSignal) => call(name, args, decode, signal);
}
// Separate, closed mutation seam. The product UI must also have an integrated
// identity context before it exposes these calls; the gateway remains authoritative.
export function createMutator(transport: Transport = (target, init) => fetch(target, init)) {
  const call = createCaller(transport, writeTools);
  return <T>(name: WriteTool, args: Record<string, unknown>, decode: (value: Record<string, unknown>) => T, signal?: AbortSignal) => call(name, args, decode, signal);
}
