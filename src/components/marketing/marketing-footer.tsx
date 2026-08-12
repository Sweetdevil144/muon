import Link from "next/link";
import { isExternalNavHref, mainNav } from "@/lib/marketing-content";
import { BrandMark } from "./brand-mark";

/** Utility/legal links, kept separate from the primary marketing nav above so
 *  the header doesn't have to carry them. Footer-only by design. */
const legalNav = [
  { label: "Download", href: "/download" },
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Licenses", href: "/licenses" },
] as const;

export function MarketingFooter() {
  return (
    <footer className="border-t-2 border-white bg-[var(--bauhaus-ink)] text-white">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_auto]">
        <div>
          <BrandMark inverse />
          <p className="mt-6 max-w-md text-sm leading-6 text-white/60">
            MUON turns the AI coding tools you already use into one crew.
            Shared context. Clear ownership. People still decide what ships.
          </p>
        </div>
        <nav aria-label="Footer navigation" className="grid grid-cols-2 gap-4 sm:flex">
          {mainNav.map((item) => (
            <Link
              className="text-sm font-bold text-white/70 underline-offset-4 hover:text-white hover:underline"
              href={item.href}
              key={item.href}
              {...(isExternalNavHref(item.href)
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="border-t border-white/20 px-4 py-5 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col items-center gap-3 sm:flex-row sm:justify-between">
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.18em] text-white/45">
            © 2026 MUON LABS
          </p>
          <nav
            aria-label="Legal navigation"
            className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2"
          >
            {legalNav.map((item) => (
              <Link
                className="text-[0.68rem] font-bold uppercase tracking-[0.18em] text-white/45 hover:text-white/80"
                href={item.href}
                key={item.href}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
