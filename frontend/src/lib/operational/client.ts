import * as decode from "./contracts";
import { OperationalError } from "./state";
import { createReader, type Transport } from "./transport";
function logical(value: string): string { if (!value || value.length > 256 || Array.from(value).some(char => char.charCodeAt(0) < 32)) throw new OperationalError("unknown"); return value; }
function knownJob(value: string): string { if (!/^job_[a-f0-9]{32}$/.test(value)) throw new OperationalError("unknown"); return value; }
export function createOperationalClient(transport?: Transport) {
  const read = createReader(transport);
  const jobRead = <T>(name: "agent_status" | "agent_result" | "agent_diff", id: string, parser: (value: Record<string, unknown>) => T & { jobId: string }, signal?: AbortSignal) => read(name, { jobId: knownJob(id), ...(name === "agent_diff" ? { maxBytes: 16_384 } : {}) }, value => { const result = parser(value); if (result.jobId !== id) throw new OperationalError("unknown"); return result; }, signal);
  return {
    targets: (signal?: AbortSignal) => read("targets_list", {}, decode.targets, signal),
    target: (target: string, signal?: AbortSignal) => read("target_inspect", { target: logical(target) }, value => { const result = decode.targetDetail(value); if (result.id !== target) throw new OperationalError("unknown"); return result; }, signal),
    projects: (signal?: AbortSignal) => read("agent_projects", {}, decode.projects, signal),
    backends: (signal?: AbortSignal) => read("agents_list", {}, decode.backends, signal),
    job: (id: string, signal?: AbortSignal) => jobRead("agent_status", id, decode.job, signal),
    result: (id: string, signal?: AbortSignal) => jobRead("agent_result", id, decode.jobResult, signal),
    diff: (id: string, signal?: AbortSignal) => jobRead("agent_diff", id, decode.jobDiff, signal),
    gitStatus: (target: string, signal?: AbortSignal) => read("git_status", { target: logical(target) }, decode.gitOutput, signal),
    gitDiff: (target: string, signal?: AbortSignal) => read("git_diff", { target: logical(target) }, decode.gitOutput, signal),
    gitLog: (target: string, signal?: AbortSignal) => read("git_log", { target: logical(target) }, decode.gitOutput, signal),
    repositories: (signal?: AbortSignal) => read("github_repositories", {}, decode.repositories, signal),
    control: (view: decode.ControlView, signal?: AbortSignal) => { if (!decode.controlViews.includes(view)) throw new OperationalError("unknown"); return read("control_center_query", { view, limit: 50 }, value => decode.control(view, value), signal); },
  };
}
export type OperationalClient = ReturnType<typeof createOperationalClient>;
