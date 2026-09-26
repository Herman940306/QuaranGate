import type { Metadata } from "next";
import { GitHub } from "../../../components/operational-github";
export const metadata: Metadata = { title: "GitHub" };
export default function Page() { return <GitHub />; }
