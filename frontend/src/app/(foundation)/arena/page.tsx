import type { Metadata } from "next";
import { AgentArena } from "../../../components/agent-arena";
export const metadata: Metadata = { title: "Agent Arena" };
export default function Page() { return <AgentArena />; }
