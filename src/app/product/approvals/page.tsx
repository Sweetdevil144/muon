import type { Metadata } from "next";
import { ProductDetailPage } from "@/components/marketing/product-detail-page";
import { productPages } from "@/lib/marketing-content";

export const metadata: Metadata = { title: "Approvals, MUON" };

export default function ApprovalsPage() {
  return <ProductDetailPage content={productPages.approvals} />;
}
