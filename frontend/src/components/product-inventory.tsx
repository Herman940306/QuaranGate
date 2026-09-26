"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Inventory, ProductClient, ProductContext, ProfileIntent, ProfileView, ProviderIntent, ProviderView, Result } from "../lib/client/product/contracts";
import { ProductBoundary } from "./product-boundary";
import { ProfileEditor } from "./product-profile-editor";
import { ProviderEditor } from "./product-provider-editor";
import { ProductCancel, ProductFeedback, useProductRequest } from "./product-state";
import { MetadataTable } from "./operational-read";
import { Badge, Button, EmptyState, Panel } from "./primitives";
type Item = ProviderView | ProfileView;
export function Providers() { return <ProductBoundary>{(client, context) => <InventoryView mode="providers" client={client} context={context} />}</ProductBoundary>; }
export function AgentProfiles() { return <ProductBoundary>{(client, context) => <InventoryView mode="profiles" client={client} context={context} />}</ProductBoundary>; }
function InventoryView({ mode, client, context }: { mode: "providers" | "profiles"; client: ProductClient; context?: ProductContext }) {
  const title = mode === "providers" ? "Providers" : "Agent Profiles";
  const { result, run, cancel, pending } = useProductRequest<Inventory<Item>>();
  const [selected, setSelected] = useState<string>(); const [editing, setEditing] = useState(false);
  const focusRecovery = useRef(false);
  useEffect(() => { if (focusRecovery.current && !pending && !editing) { document.getElementById("product-refresh")?.focus(); focusRecovery.current = false; } }, [pending, editing]);
  const data = result.kind === "available" ? result.data : undefined;
  const item = data?.items.find(i => i.id === selected);
  const ready = client.integrated && Boolean(context);
  function refresh() { if (!context || !ready) return; setEditing(false); setSelected(undefined); run(s => mode === "providers" ? client.listProviders(context, s) : client.listProfiles(context, s)); }
  function inspect(id: string) {
    if (!context || !data) return; setSelected(id); setEditing(false);
    run(async s => { const r = mode === "providers" ? await client.inspectProvider(context, id, s) : await client.inspectProfile(context, id, s); return r.kind === "available" ? { kind: "available", data: { ...data, items: data.items.map(i => i.id === id ? r.data : i) } } : r; });
  }
  function save(intent: ProviderIntent | ProfileIntent) {
    if (!context || !data) { if ("secretValue" in intent) delete intent.secretValue; return; }
    setEditing(false); focusRecovery.current = true;
    run(async s => {
      const r: Result<Item> = mode === "providers" ? await client.saveProvider(context, intent as ProviderIntent, data.options, s) : await client.saveProfile(context, intent as ProfileIntent, data.options, s);
      if (r.kind !== "available") return r;
      setSelected(r.data.id);
      return { kind: "available", data: { ...data, items: [...data.items.filter(i => i.id !== r.data.id), r.data] } };
    });
  }
  function validate() {
    if (!context || !data || !item || !("validation" in item)) return; focusRecovery.current = true;
    run(async s => { const r = await client.validateProvider(context, item.id, item.version, s); return r.kind === "available" ? { kind: "available", data: { ...data, items: data.items.map(i => i.id === item.id ? r.data : i) } } : r; });
  }
  return <><div className="page-heading"><div><p className="eyebrow">PRODUCT CONFIGURATION</p><h1>{title}</h1><p className="page-intro">{mode === "providers" ? "Safe provider metadata and write-only custody intent." : "Configuration references for future governed workflows."}</p></div><Badge>Configuration · no grants</Badge></div>
    <div className="authority-strip" style={{ forcedColorAdjust: "none" }}><span className="authority-label">AUTHORITY BOUNDARY</span><strong>Configuration and validation do not grant operational authority.</strong><span>ACP admission, Principal grants and runtime preconditions remain separate.</span></div>
    <Panel title={`${title} inventory`}><p className="muted">{context ? `Current workspace: ${context.workspaceId}` : "No verified product context. Identity integration is required."}</p><div className="form-actions"><Button id="product-refresh" disabled={!ready} busy={pending} onClick={refresh}>Re-read configuration</Button>{pending ? <ProductCancel cancel={() => { focusRecovery.current = true; cancel(); }} /> : null}{data && !pending ? <Button onClick={() => { setSelected(undefined); setEditing(true); }}>Create {mode === "providers" ? "provider" : "profile"}</Button> : null}</div>
      {!ready ? <ProductFeedback kind="integration_pending" /> : result.kind !== "available" ? <ProductFeedback kind={result.kind} /> : null}
      {data && !editing ? data.items.length ? <div className="form-actions">{data.items.map(i => <Button key={i.id} onClick={() => inspect(i.id)} aria-pressed={selected === i.id}>{"name" in i ? i.name : `${i.kind} · ${i.id}`}</Button>)}</div> : <EmptyState title={mode === "providers" ? "No providers configured" : "No profiles configured"}>Create configuration only when current server options are available.</EmptyState> : null}
    </Panel>
    {editing && data ? <Panel title={item ? "Edit configuration" : "New configuration"}>{mode === "providers" ? <ProviderEditor provider={item as ProviderView | undefined} options={data.options} submit={save} cancel={() => { focusRecovery.current = true; setEditing(false); }} /> : <ProfileEditor profile={item as ProfileView | undefined} options={data.options} submit={save} cancel={() => { focusRecovery.current = true; setEditing(false); }} />}</Panel> : null}
    {item && !editing ? <Panel title="Safe configuration detail"><MetadataTable caption="Configuration metadata" rows={"validation" in item ? [{ label: "Provider", value: item.id }, { label: "Kind", value: item.kind }, { label: "Owner scope", value: item.ownerScope }, { label: "Configured", value: item.configured ? "Saved configuration" : "Not configured" }, { label: "Masked hint", value: item.maskedHint ?? "Unknown" }, { label: "Validation status", value: item.validation }, { label: "Updated (UTC)", value: item.updatedAt }, { label: "Version", value: item.version }] : [{ label: "Profile", value: item.id }, { label: "Name", value: item.name }, { label: "Backend reference", value: item.backend }, { label: "ACP profile reference", value: item.acpProfile }, { label: "Logical project", value: item.project }, { label: "Resource policy reference", value: item.resourcePolicy }, { label: "Capability preferences", value: item.capabilities.join(", ") || "None returned" }, { label: "Version", value: item.version }]} />
      <div className="form-actions"><Button onClick={() => setEditing(true)}>Edit configuration</Button>{"validation" in item ? <Button onClick={validate}>Request provider validation</Button> : null}<Button disabled>{mode === "providers" ? "Remove / disable pending" : "Delete profile pending"}</Button></div><p className="muted">Removal requires an accepted safe semantic contract. No removal request is sent.</p>
      {"validation" in item ? <p>Validation {item.validation}. This is a server-returned configuration check, not ACP/provider admission or an operational grant.</p> : <p>No dispatch is performed by Agent Profile selection.</p>}
    </Panel> : null}
    <Panel title={mode === "providers" ? "Provider admission is separate" : "Dispatch handoff pending"}><p>{mode === "providers" ? "Saved configuration, validation status, ACP/provider admission and operational authority are four distinct states. This page provides only the first two when a server adapter is accepted." : "A future workflow selects a profile, requests server preflight, preserves existing agent_dispatch authority, and surfaces current resource/runtime preconditions. Browser references never widen authority."}</p><Link href="/agents">Inspect current operational backend visibility</Link><p className="muted">The existing Agents view is an operational read via agents_list; it is separate from product configuration.</p></Panel>
  </>;
}
