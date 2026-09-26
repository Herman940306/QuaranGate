import type { Metadata } from "next";
import { Processes } from "../../../components/operational-workstation";
export const metadata: Metadata = { title: "Processes" };
export default function Page() { return <Processes />; }
