import type { Metadata } from "next";
import { Jobs } from "../../../components/operational-jobs";
export const metadata: Metadata = { title: "Jobs" };
export default function Page() { return <Jobs />; }
