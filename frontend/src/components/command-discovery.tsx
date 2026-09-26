"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { productRoutes } from "../lib/navigation";
import { toolCatalog } from "../lib/operational/tool-catalog";
import { useOverlay } from "./overlays";
import { Button, Input } from "./primitives";
function SearchResults() {
  const [query, setQuery] = useState(""); const overlay = useOverlay();
  const search = query.trim().toLowerCase();
  const routes = productRoutes.filter(([path,label]) => `${path} ${label}`.toLowerCase().includes(search));
  const tools = search ? toolCatalog.filter(tool => `${tool.name} ${tool.purpose} ${tool.authority}`.toLowerCase().includes(search)) : [];
  return <><Input id="command-search" label="Find page or tool" value={query} maxLength={128} onChange={event => setQuery(event.target.value)} help="Navigation only. No tool is executed." /><nav aria-label="Page search results">{routes.map(([href,label]) => <p key={href}><Link href={href} onClick={overlay.close}>{label}</Link></p>)}</nav><nav aria-label="Tool search results">{tools.map(tool => <p key={tool.name}><Link href="/tool-lab" onClick={overlay.close}>{tool.name} · {tool.authority} · Open Tool Lab</Link></p>)}</nav>{!routes.length && !tools.length ? <p>No supported page or tool matches.</p> : null}</>;
}
export function CommandDiscovery() {
  const overlay = useOverlay();
  const open = () => overlay.open({ title: "Find pages & tools", description: "Navigate to a governed workflow. Confirmation and server authorization still apply to every operation.", children: <SearchResults /> });
  useEffect(() => { const key = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); open(); } }; window.addEventListener("keydown",key);return () => window.removeEventListener("keydown",key); });
  return <Button onClick={open}>Find pages & tools</Button>;
}
