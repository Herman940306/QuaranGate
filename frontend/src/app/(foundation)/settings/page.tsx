import type { Metadata } from "next";
import { version } from "../../../../package.json";
import { SettingsCenter } from "../../../components/settings-center";
export const metadata: Metadata = { title: "Settings" };
export default function Page() { return <SettingsCenter frontendVersion={version} />; }
