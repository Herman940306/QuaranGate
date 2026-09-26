import type { Metadata } from "next";
import { notFound } from "next/navigation";
export const metadata: Metadata = { title: "Synthetic approvals preview" };
export default async function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  const { ApprovalsPreview } = await import("../../components/approvals-preview");
  return <ApprovalsPreview />;
}
