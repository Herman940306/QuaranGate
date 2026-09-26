"use client";
import { useOperational } from "./operational-provider";
import { OperationalHeading, ReadPanel } from "./operational-read";
import { EmptyState, Table } from "./primitives";
export function GitHub() {
  const { client } = useOperational();
  return <><OperationalHeading title="GitHub">Discover governed repositories. Read availability grants no write or review authority; remote operations are not offered here.</OperationalHeading><ReadPanel title="Repository discovery" action="Read repositories" operation={signal => client.repositories(signal)}>{rows => <><p className="muted">Showing up to 100 of {rows.length} repositories returned. Discovery has no caller pagination contract; this cap applies only to display.</p>{rows.length ? <Table caption="Governed repositories" headings={["Repository", "Owner", "Private", "Archived", "Local project"]} rows={rows.slice(0, 100).map((row, i) => ({ id: String(i), cells: { Repository: row.repository, Owner: row.owner, Private: String(row.private), Archived: String(row.archived), "Local project": row.localProject } }))} /> : <EmptyState title="No repositories returned">No governed repository discovery results are exposed.</EmptyState>}</>}</ReadPanel></>;
}
