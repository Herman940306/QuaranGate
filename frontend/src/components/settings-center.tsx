"use client";
import { settingsIdentity } from "../lib/settings";
import { AppearanceControls } from "./appearance-controls";
import { useIdentity } from "./identity-provider";
import { useOperational } from "./operational-provider";
import { MetadataTable, OperationalHeading, ReadPanel } from "./operational-read";
import { Panel } from "./primitives";
export function SettingsCenter({ frontendVersion }: { frontendVersion: string }) {
  const identity = useIdentity(); const { client } = useOperational();
  return <>
    <OperationalHeading title="Settings">Product appearance and current read-only state. Appearance changes are local presentation only; they never change backend configuration or operational authority.</OperationalHeading>
    <Panel title="Page-memory appearance"><AppearanceControls /><p>No preference, credential or configuration value is persisted. Reload restores default appearance.</p></Panel>
    <Panel title="Current product identity"><MetadataTable caption="Settings identity" rows={settingsIdentity(identity.state)} /><p>Session identity is not authorization. Membership, roles and principal mapping do not bypass operation-specific server checks.</p></Panel>
    <Panel title="Frontend build input"><MetadataTable caption="Frontend version" rows={[{ label: "Frontend package version", value: frontendVersion }, { label: "Deployed runtime revision", value: "UNKNOWN" }]} /><p>The package version is a declared frontend build input, not proof of live deployment or gateway/executor revision.</p></Panel>
    <ReadPanel title="Current capability visibility" action="Read settings capabilities" operation={signal => client.control("capabilities", signal)}>{snapshot => <MetadataTable caption="Settings capabilities" rows={snapshot.rows} />}</ReadPanel>
    <ReadPanel title="Provider availability metadata" action="Read settings providers" operation={signal => client.control("providers", signal)}>{snapshot => <><MetadataTable caption="Settings providers" rows={snapshot.rows} /><p>Availability does not establish provider entitlement or authority for this principal.</p></>}</ReadPanel>
    <Panel title="Configuration ownership"><p>Backend policy/configuration editing is NOT_AVAILABLE here: no accepted governed settings mutation API is connected. Docker settings, provider keys, host secrets, scope/grant editing and GitHub installation administration remain outside this surface.</p></Panel>
  </>;
}
