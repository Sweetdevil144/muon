import type { Metadata } from "next";
import { ProductDetailPage } from "@/components/marketing/product-detail-page";
import { productPages } from "@/lib/marketing-content";

export const metadata: Metadata = { title: "Shared memory, MUON" };

export default function SharedMemoryPage() {
  return <ProductDetailPage content={productPages["shared-memory"]} />;
}
