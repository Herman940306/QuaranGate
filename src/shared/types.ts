/** Wire types for the gateway → executor internal API. */

export interface TargetInfo {
  id: string;
  name: string;
  source: 'manual' | 'discovered';
  composeProject: string | null;
  composeService: string | null;
  workspace: string;
  running: boolean;
  image?: string;
  containerId?: string;
  status?: string;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface FileStat {
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mode: string;
  mtime: string;
  linkTarget?: string;
}

export interface ExecRequest {
  targetId: string;
  /** argv form: no shell. shell form: run via /bin/sh -c (terminal_exec only). */
  argv?: string[];
  shellCommand?: string;
  cwd?: string; // workspace-relative
  timeoutMs?: number;
  maxOutputBytes?: number;
  principal: string; // for concurrency accounting + audit correlation
}

export interface WriteFileRequest {
  targetId: string;
  path: string; // workspace-relative
  contentBase64: string;
  mode?: number;
}

export const EXECUTOR_DEFAULTS = {
  timeoutMs: 60_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 256 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  perPrincipalConcurrency: 4,
  globalConcurrency: 16,
} as const;
