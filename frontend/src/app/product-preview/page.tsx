import type { Metadata } from "next";
import { notFound } from "next/navigation";
export const metadata: Metadata = { title: "Synthetic configuration preview" };
export default async function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  const { ProductPreview } = await import("../../components/product-preview");
  return <ProductPreview />;
}
