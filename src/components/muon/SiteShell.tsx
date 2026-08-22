import type { ReactNode } from "react";

import { TopRail } from "./TopRail";
import { StatusRail } from "./StatusRail";

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-muon-yellow/30">
      <TopRail />
      <main className="mx-auto max-w-[1440px] px-4">{children}</main>
      <StatusRail />
    </div>
  );
}
