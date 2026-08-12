import type { Metadata } from "next";
import { ProductDetailPage } from "@/components/marketing/product-detail-page";
import { productPages } from "@/lib/marketing-content";

export const metadata: Metadata = { title: "Agent lanes, MUON" };

export default function AgentLanesPage() {
  return <ProductDetailPage content={productPages["agent-lanes"]} />;
}
