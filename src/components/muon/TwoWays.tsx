import Link from "next/link";

/**
 * The commercial seam (2026-08-23 marketing appendix §4): Individual and
 * Teams, side by side with the same visual weight, after the product story
 * and before TrustClose. The one sentence this section exists to land is the
 * grant's own line — one person's brain on one person's devices is covered;
 * a shared brain across people is not. There is deliberately no third
 * Company column: that is a later conversation, not a card.
 *
 * Responsive contract from the appendix: two full columns on desktop, two
 * stacked sections on small screens, each keeping its own CTA — Teams is
 * never hidden behind a fold.
 */
export function TwoWays() {
  return (
    <section className="border-t border-border py-20 lg:py-28">
      <div className="mb-10 max-w-[72ch]">
        <h2 className="mb-4 font-sans text-[1.75rem] font-semibold tracking-[-0.02em] lg:text-4xl">
          Two ways to run MUON
        </h2>
        <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
          As long as MUON is one person&apos;s brain on one person&apos;s devices, the Individual
          Use Grant covers you. The moment it becomes a shared brain across people, it does not —
          and that is the product we license.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="panel flex flex-col p-8">
          <p className="panel-label mb-3">Individual</p>
          <p className="mb-6 text-[0.9375rem] leading-relaxed text-muted-foreground">
            For one natural person, including on a laptop your employer issued. The full local
            product: desk, crews, confirmed memory, the dual graph, approvals, and packs you carry
            between your own machines. Free, no card, no meter — we do not charge for remembering,
            and we do not charge per agent.
          </p>
          <Link href="/download" className="mt-auto btn-primary w-full">
            Install the app
          </Link>
        </div>

        <div className="panel flex flex-col p-8">
          <p className="panel-label mb-3">Teams</p>
          <p className="mb-6 text-[0.9375rem] leading-relaxed text-muted-foreground">
            For two or more people who need those instances to share memory, graphs, crews, claims,
            or findings. That is Linked Operation. It is licensed per named person who is linked,
            and it does not take the Individual product away from anyone who stays alone.
          </p>
          <Link href="/enterprise" className="mt-auto btn-ghost w-full">
            Talk about linking instances
          </Link>
        </div>
      </div>
    </section>
  );
}
