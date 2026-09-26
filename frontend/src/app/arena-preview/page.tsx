import type { Metadata } from "next";
import { notFound } from "next/navigation";
export const metadata: Metadata = { title: "Synthetic Agent Arena preview" };
export default async function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  const { ArenaPreview } = await import("../../components/arena-preview");
  return <ArenaPreview />;
}
