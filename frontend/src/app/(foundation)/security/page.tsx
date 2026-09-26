import type { Metadata } from "next";
import { ControlCenter } from "../../../components/operational-control";
export const metadata: Metadata = { title: "Security & Access" };
export default function Page() { return <ControlCenter security />; }
