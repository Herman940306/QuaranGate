import type { Metadata } from "next";
import { SecurityExplorer } from "../../../components/security-explorer";
export const metadata: Metadata = { title: "Security & Access" };
export default function Page() { return <SecurityExplorer />; }
