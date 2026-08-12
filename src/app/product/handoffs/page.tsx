import type { Metadata } from "next";
import { ProductDetailPage } from "@/components/marketing/product-detail-page";
import { productPages } from "@/lib/marketing-content";

export const metadata: Metadata = { title: "Handoffs, MUON" };

export default function HandoffsPage() {
  return <ProductDetailPage content={productPages.handoffs} />;
}
