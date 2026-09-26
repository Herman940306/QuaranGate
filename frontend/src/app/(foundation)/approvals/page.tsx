import type { Metadata } from "next";
import { Approvals } from "../../../components/approvals";
export const metadata: Metadata = { title: "Review & Approvals" };
export default function Page() { return <Approvals />; }
