import type { ReactNode } from "react";
import { MarketingFooter } from "./marketing-footer";
import { MarketingNav } from "./marketing-nav";

export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[var(--bauhaus-paper)] text-[var(--bauhaus-ink)]">
      <MarketingNav />
      <main>{children}</main>
      <MarketingFooter />
    </div>
  );
}
