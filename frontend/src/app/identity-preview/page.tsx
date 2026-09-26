import type { Metadata } from "next";
import { notFound } from "next/navigation";
export const metadata: Metadata = { title: "Synthetic identity preview" };
export default async function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  const { IdentityPreview } = await import("../../components/identity-preview");
  return <IdentityPreview />;
}
