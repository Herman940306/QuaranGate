"use client";
import { useEffect, useRef, useState } from "react";
import type { ProductOptions, ProfileIntent, ProfileView } from "../lib/client/product/contracts";
import { Button, Input, Select } from "./primitives";
export function ProfileEditor({ profile, options, submit, cancel }: { profile?: ProfileView; options: ProductOptions; submit: (i: ProfileIntent) => void; cancel: () => void }) {
  const form = useRef<HTMLFormElement>(null); const [error, setError] = useState(false);
  useEffect(() => { form.current?.querySelector<HTMLInputElement>("input")?.focus(); }, []);
  return <form ref={form} noValidate onSubmit={e => {
    e.preventDefault(); const fields = e.currentTarget.elements;
    const value = (id: string) => (fields.namedItem(id) as HTMLInputElement | HTMLSelectElement).value;
    if (!value("profile-name").trim()) { setError(true); form.current?.querySelector<HTMLInputElement>("input")?.focus(); return; }
    submit({ name: value("profile-name"), backend: value("backend"), acpProfile: value("acpProfile"), project: value("project"), resourcePolicy: value("resourcePolicy"), capabilities: options.capabilities.filter(o => (fields.namedItem(`cap-${o.id}`) as HTMLInputElement)?.checked).map(o => o.id), optionsVersion: options.version, ...(profile ? { id: profile.id, expectedVersion: profile.version } : {}) });
  }}><p>Only current server-returned configuration references are selectable. These preferences create no operational grants.</p>
    <Input id="profile-name" name="profile-name" label="Profile name" maxLength={256} defaultValue={profile?.name ?? ""} error={error ? "Enter a bounded profile name." : undefined} />
    {(["backend", "acpProfile", "project", "resourcePolicy"] as const).map((field, index) => <Select key={field} id={field} name={field} label={["Backend reference", "ACP profile reference", "Logical project", "Resource policy reference"][index]} defaultValue={profile?.[field] ?? ""}><option value="">Choose a returned reference</option>{options[({ backend: "backends", acpProfile: "acpProfiles", project: "projects", resourcePolicy: "resourcePolicies" } as const)[field]].map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>)}
    <fieldset><legend>Approved capability preferences · display only</legend>{options.capabilities.length ? options.capabilities.map(o => <label key={o.id}><input type="checkbox" name={`cap-${o.id}`} defaultChecked={profile?.capabilities.includes(o.id)} /> {o.label}</label>) : <p>No preferences returned.</p>}</fieldset>
    <div className="form-actions"><Button type="submit" emphasis="solid">Submit profile</Button><Button onClick={cancel}>Cancel editor</Button></div>
  </form>;
}
