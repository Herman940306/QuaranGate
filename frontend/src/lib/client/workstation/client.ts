import { bool, count, gitOutput, targetDetail, text } from "../../operational/contracts";
import { OperationalError } from "../../operational/state";
import { createMutator, createReader, type Transport } from "../../operational/transport";

function hasControl(value: string): boolean { return Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127); }
function logical(value: string): string {
  if (!value || value.length > 256 || hasControl(value)) throw new OperationalError("unknown");
  return value;
}
export function workspacePath(value: string, allowRoot = false): string {
  if ((value === "" && allowRoot)) return value;
  if (!value || value.length > 1024 || value.startsWith("/") || value.includes("\\") || hasControl(value) || value.split("/").some(segment => segment === "" || segment === "." || segment === "..")) throw new OperationalError("unknown");
  return value;
}
function bounded(value: string, max: number): string {
  if (!value || value.length > max) throw new OperationalError("unknown");
  return value;
}
function exactPath(value: Record<string, unknown>, path: string) {
  const returned = text(value.path, 1024);
  if (returned !== path) throw new OperationalError("unknown");
  return returned;
}
export interface FileStat { path: string; type: "file" | "dir" | "symlink" | "other"; size: number; mode: string; mtime: string; linkTarget?: string }
export interface FileContent { path: string; bytes: number; content: string }
export interface PathReceipt { ok: true; path: string }
export interface TargetControlReceipt { ok: true; target: string; action: "start" | "stop" | "restart"; running: boolean; status: string; health?: string }
function fileStat(value: Record<string, unknown>, path: string): FileStat {
  const type = value.type;
  if (type !== "file" && type !== "dir" && type !== "symlink" && type !== "other") throw new OperationalError("unknown");
  return { path: exactPath(value, path), type, size: count(value.size), mode: text(value.mode, 64), mtime: text(value.mtime, 64), linkTarget: value.linkTarget === undefined ? undefined : text(value.linkTarget, 1024) };
}
function pathReceipt(value: Record<string, unknown>, path: string): PathReceipt {
  if (value.ok !== true) throw new OperationalError("unknown");
  return { ok: true, path: exactPath(value, path) };
}
function targetControl(value: Record<string, unknown>, target: string, action: TargetControlReceipt["action"]): TargetControlReceipt {
  if (value.ok !== true || value.target !== target || value.action !== action) throw new OperationalError("unknown");
  return { ok: true, target, action, running: bool(value.running), status: text(value.status, 256), health: value.health === undefined ? undefined : text(value.health, 256) };
}
export function createWorkstationClient(transport?: Transport) {
  const read = createReader(transport);
  const mutate = createMutator(transport);
  return {
    listFiles: (target: string, path = "", signal?: AbortSignal) => read("fs_list", { target: logical(target), path: workspacePath(path, true), maxDepth: 1 }, value => {
      if (!Array.isArray(value.entries) || value.entries.length > 1000) throw new OperationalError("unknown");
      return value.entries.map(entry => text(entry, 1024));
    }, signal),
    statFile: (target: string, path: string, signal?: AbortSignal) => read("fs_stat", { target: logical(target), path: workspacePath(path) }, value => fileStat(value, path), signal),
    readFile: (target: string, path: string, signal?: AbortSignal) => read("fs_read", { target: logical(target), path: workspacePath(path) }, value => ({ path: exactPath(value, path), bytes: count(value.bytes), content: text(value.content, 1_048_576) }), signal),
    searchFiles: (target: string, path: string, query: string, signal?: AbortSignal) => read("fs_search", { target: logical(target), path: workspacePath(path, true), query: bounded(query, 256), maxResults: 100 }, value => {
      if (!Array.isArray(value.matches) || value.matches.length > 100) throw new OperationalError("unknown");
      return value.matches.map(match => text(match, 2048));
    }, signal),
    processes: (target: string, signal?: AbortSignal) => read("process_list", { target: logical(target) }, gitOutput, signal),
    writeFile: (target: string, path: string, content: string, signal?: AbortSignal) => mutate("fs_write", { target: logical(target), path: workspacePath(path), content: text(content, 262_144) }, value => pathReceipt(value, path), signal),
    patchFile: (target: string, path: string, oldText: string, newText: string, signal?: AbortSignal) => mutate("fs_patch", { target: logical(target), path: workspacePath(path), oldText: bounded(oldText, 65_536), newText: text(newText, 65_536) }, value => pathReceipt(value, path), signal),
    deleteFile: (target: string, path: string, signal?: AbortSignal) => mutate("fs_delete", { target: logical(target), path: workspacePath(path), recursive: false }, value => pathReceipt(value, path), signal),
    execute: (target: string, command: string, cwd: string, signal?: AbortSignal) => mutate("terminal_exec", { target: logical(target), command: bounded(command, 4096), ...(cwd ? { cwd: workspacePath(cwd) } : {}), timeoutMs: 20_000 }, gitOutput, signal),
    controlTarget: (target: string, action: TargetControlReceipt["action"], signal?: AbortSignal) => {
      const name = { start: "target_start", stop: "target_stop", restart: "target_restart" } as const;
      return mutate(name[action], { target: logical(target) }, value => targetControl(value, target, action), signal);
    },
    inspectTarget: (target: string, signal?: AbortSignal) => read("target_inspect", { target: logical(target) }, value => { const result = targetDetail(value); if (result.id !== target) throw new OperationalError("unknown"); return result; }, signal),
  };
}
export type WorkstationClient = ReturnType<typeof createWorkstationClient>;
