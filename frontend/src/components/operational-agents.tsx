"use client";
import { useOperational } from "./operational-provider";
import { OperationalHeading, ReadPanel } from "./operational-read";
import { EmptyState, Table } from "./primitives";
export function Projects() {
  const { client } = useOperational();
  return <><OperationalHeading title="Projects">Logical projects and configured backend/profile grants. Dispatch and mutation are outside this read surface.</OperationalHeading><ReadPanel title="Agent projects" action="Read projects" operation={signal => client.projects(signal)}>{rows => rows.length ? <Table caption="Agent projects" headings={["Project", "Git required", "Backends", "Profiles"]} rows={rows.map((row, i) => ({ id: String(i), cells: { Project: row.id, "Git required": String(row.gitRequired), Backends: row.allowedBackends.join(", ") || "None exposed", Profiles: row.allowedProfiles.join(", ") || "None exposed" } }))} /> : <EmptyState title="No projects returned">No projects are exposed for this principal.</EmptyState>}</ReadPanel></>;
}
export function Agents() {
  const { client } = useOperational();
  return <><OperationalHeading title="Agents">Configured availability does not prove production qualification, entitlement or permission to dispatch.</OperationalHeading><ReadPanel title="Agent backends" action="Read backends" operation={signal => client.backends(signal)}>{rows => rows.length ? <Table caption="Agent backends" headings={["Backend", "Availability", "Profiles", "Qualification"]} rows={rows.map((row, i) => ({ id: String(i), cells: { Backend: row.id, Availability: row.available ? "Available (configured)" : "Unavailable / deferred", Profiles: row.profiles.join(", ") || "None exposed", Qualification: "UNKNOWN · see Control Center capabilities" } }))} /> : <EmptyState title="No backends returned">No backend metadata is exposed.</EmptyState>}</ReadPanel></>;
}
