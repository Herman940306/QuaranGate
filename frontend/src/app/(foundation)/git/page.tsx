import type { Metadata } from "next";
import { Git } from "../../../components/operational-git";
export const metadata: Metadata = { title: "Git" };
export default function Page() { return <Git />; }
