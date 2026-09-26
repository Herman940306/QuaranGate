import type { Metadata } from "next";
import { Terminal } from "../../../components/operational-workstation";
export const metadata: Metadata = { title: "Terminal" };
export default function Page() { return <Terminal />; }
