import Link from "next/link";

import { GithubMark as Github } from "./BrandIcon";
import { MuonMark } from "./MuonMark";

/**
 * The footer is one line, by instruction (the 2026-08-23 marketing appendix
 * withdrew the earlier "open source is the only claim" one — the controlling
 * texts are PolyForm Noncommercial 1.0.0 plus the Individual Use Grant, and
 * "open source" as an unadorned claim trained the wrong buyer). The line now
 * says exactly what is true: the source is public, individual use is
 * granted. Legal links stay because they have no other home.
 */
const LEGAL = [
  { label: "Privacy", to: "/privacy" },
  { label: "Terms", to: "/terms" },
  { label: "Licenses", to: "/licenses" },
] as const;

export function StatusRail() {
  return (
    <footer className="mt-24 border-t border-rule">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 py-6">
        <div className="flex items-center gap-3">
          <MuonMark className="size-5" />
          <span className="text-[13px] text-muted-foreground">
            Source is public. Individual use is granted. An asset of{" "}
            <a
              href="https://quantistic.ai/"
              className="text-foreground underline underline-offset-4"
            >
              Quantistic
            </a>
            .
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-5">
          {LEGAL.map((link) => (
            <Link key={link.label} href={link.to} className="nav-link text-[13px]">
              {link.label}
            </Link>
          ))}
          <a
            href="https://github.com/Sweetdevil144/muon"
            aria-label="MUON on GitHub"
            className="nav-link"
          >
            <Github className="size-4" />
          </a>
        </div>
      </div>
    </footer>
  );
}
