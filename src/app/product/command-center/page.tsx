import type { Metadata } from "next";
import { ProductDetailPage } from "@/components/marketing/product-detail-page";
import { productPages } from "@/lib/marketing-content";

export const metadata: Metadata = { title: "Command center, MUON" };

export default function CommandCenterPage() {
  return <ProductDetailPage content={productPages["command-center"]} />;
}
