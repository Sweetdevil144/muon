import type { Metadata } from "next";
import { ProductDetailPage } from "@/components/marketing/product-detail-page";
import { productPages } from "@/lib/marketing-content";

export const metadata: Metadata = { title: "Human control, MUON" };

export default function HumanControlPage() {
  return <ProductDetailPage content={productPages["human-control"]} />;
}
