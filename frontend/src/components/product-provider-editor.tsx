"use client";
import { useEffect, useRef, useState } from "react";
import type { ProductOptions, ProviderIntent, ProviderView } from "../lib/client/product/contracts";
import { Button, Input, Select } from "./primitives";
export function ProviderEditor({ provider, options, submit, cancel }: { provider?: ProviderView; options: ProductOptions; submit: (intent: ProviderIntent) => void; cancel: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<"provider-kind" | "provider-scope">();
  const secretField = () => form.current?.querySelector<HTMLInputElement>("#provider-secret");
  useEffect(() => { form.current?.querySelector<HTMLInputElement | HTMLSelectElement>("input,select")?.focus(); const field = form.current?.querySelector<HTMLInputElement>("#provider-secret"); return () => { if (field) field.value = ""; }; }, []);
  function clear() { const field = secretField(); if (field) field.value = ""; }
  return <form ref={form} noValidate onSubmit={e => {
    e.preventDefault(); const fields = e.currentTarget.elements;
    const value = (id: string) => (fields.namedItem(id) as HTMLInputElement | HTMLSelectElement).value;
    const missing = !value("provider-kind") ? "provider-kind" : !value("provider-scope") ? "provider-scope" : undefined;
    if (missing) { clear(); setError(missing); form.current?.querySelector<HTMLSelectElement>(`#${missing}`)?.focus(); return; }
    setError(undefined);
    const intent: ProviderIntent = { kind: value("provider-kind"), ownerScope: value("provider-scope"), optionsVersion: options.version, ...(provider ? { id: provider.id, expectedVersion: provider.version } : {}) };
    const field = secretField(); if (field?.value) intent.secretValue = field.value;
    clear(); submit(intent); delete intent.secretValue;
  }}><p>Metadata only. An optional secret goes once to server custody; it is never returned. Configuration does not grant operational authority.</p>
    <Select id="provider-kind" name="provider-kind" label="Provider kind" defaultValue={provider?.kind ?? ""} error={error === "provider-kind" ? "Choose a returned provider kind." : undefined}><option value="">Choose a returned kind</option>{options.providerKinds.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
    <Select id="provider-scope" name="provider-scope" label="Owner scope" defaultValue={provider?.ownerScope ?? ""} error={error === "provider-scope" ? "Choose a returned owner scope." : undefined}><option value="">Choose a returned scope</option>{options.ownerScopes.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
    <Input id="provider-secret" label="Secret (write-only)" type="password" autoComplete="new-password" maxLength={4096} help="Leave blank to retain existing custody intent. Never prefilled or revealed. Cleared on submit, cancel and unmount." />
    <div className="form-actions"><Button type="submit" emphasis="solid">Submit configuration</Button><Button onClick={() => { clear(); cancel(); }}>Cancel editor</Button></div>
  </form>;
}
