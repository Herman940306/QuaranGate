import type { Metadata } from "next";
import { ControlCenter } from "../../../components/operational-control";
export const metadata: Metadata = { title: "Control Center" };
export default function Page() { return <ControlCenter />; }
