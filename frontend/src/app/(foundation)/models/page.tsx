import type { Metadata } from "next";
import { LocalAiModels } from "../../../components/local-ai-models";
export const metadata: Metadata = { title: "Local AI & Models" };
export default function Page() { return <LocalAiModels />; }
