import type { Metadata } from "next";
import { Workspaces } from "../../../components/identity-workspaces";
export const metadata: Metadata = { title: "Workspaces" };
export default function Page() { return <Workspaces />; }
