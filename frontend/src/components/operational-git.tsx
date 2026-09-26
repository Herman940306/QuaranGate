"use client";
import { useState } from "react";
import { useOperational } from "./operational-provider";
import { MetadataTable, OperationalHeading, ReadPanel } from "./operational-read";
import { Input, MachineOutput } from "./primitives";
import type { GitOutput } from "../lib/operational/contracts";
export function GitExecution({ output }: { output: GitOutput }) {
  return <><p>{output.exitCode === 0 && !output.timedOut ? "Command completed" : "Command failed or outcome unknown"}{output.truncated ? " · output truncated" : ""}</p><MetadataTable caption="Git execution receipt" rows={[{ label: "Exit code", value: output.exitCode === null ? "UNKNOWN" : String(output.exitCode) }, { label: "Timed out", value: String(output.timedOut) }, { label: "Truncated", value: String(output.truncated) }, { label: "Duration ms", value: String(output.durationMs) }]} /><MachineOutput label="Git stdout · untrusted output">{output.stdout}</MachineOutput><MachineOutput label="Git stderr · untrusted output">{output.stderr}</MachineOutput></>;
}
export function Git() {
  const { client } = useOperational(); const [target, setTarget] = useState("");
  return <><OperationalHeading title="Git">Read workspace status, diff statistics and the last 30 commits. No Git mutation is available.</OperationalHeading><Input id="git-target" label="Logical target ID" value={target} maxLength={256} onChange={event => setTarget(event.target.value)} help="Use an authorized target ID. Selections stay in memory." />
  <div key={target}><ReadPanel ready={target.length > 0} title="Workspace status" action="Read Git status" operation={signal => client.gitStatus(target, signal)}>{output => <GitExecution output={output} />}</ReadPanel><ReadPanel ready={target.length > 0} title="Diff statistics" action="Read Git diff statistics" operation={signal => client.gitDiff(target, signal)}>{output => <GitExecution output={output} />}</ReadPanel><ReadPanel ready={target.length > 0} title="Recent commits" action="Read Git log" operation={signal => client.gitLog(target, signal)}>{output => <GitExecution output={output} />}</ReadPanel></div></>;
}
