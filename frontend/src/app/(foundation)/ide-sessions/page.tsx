import type { Metadata } from "next";
import { IdeSessionCenter } from "../../../components/ide-session-center";
export const metadata: Metadata = { title: "IDE Sessions" };
export default function Page() { return <IdeSessionCenter />; }
