import Link from "next/link";
import type { productPages } from "@/lib/marketing-content";
import { MarketingShell } from "./marketing-shell";
import { PageIntro } from "./page-intro";

type ProductDetailContent = (typeof productPages)[string];

export function ProductDetailPage({
  content,
}: {
  content: ProductDetailContent;
}) {
  return (
    <MarketingShell>
      <PageIntro
        action={{ label: "Explore the whole product", href: "/product" }}
        eyebrow={content.eyebrow}
        intro={content.intro}
        title={content.title}
      />
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="mb-16 grid border-2 border-[var(--bauhaus-ink)] bg-white lg:grid-cols-[0.38fr_1fr]">
          <div className="border-b-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-yellow)] p-7 lg:border-b-0 lg:border-r-2 sm:p-9">
            <p className="bauhaus-eyebrow">Verified availability</p>
            <p className="mt-5 text-xl font-black uppercase leading-tight tracking-[-0.03em]">
              {content.availability}
            </p>
          </div>
          <div className="grid gap-3 p-7 sm:grid-cols-2 sm:p-9">
            {content.evidence.map((item) => (
              <span
                className="flex items-start gap-3 border-l-4 border-[var(--bauhaus-blue)] bg-[var(--bauhaus-paper)] px-4 py-3 text-sm font-bold leading-6"
                key={item}
              >
                {item}
              </span>
            ))}
          </div>
        </div>

        <div className="grid border-2 border-[var(--bauhaus-ink)] lg:grid-cols-3">
          {content.points.map((point, index) => (
            <article
              className={`min-h-72 p-7 sm:p-9 ${
                index < content.points.length - 1
                  ? "border-b-2 border-[var(--bauhaus-ink)] lg:border-b-0 lg:border-r-2"
                  : ""
              }`}
              key={point.title}
            >
              <span className="text-sm font-black text-[var(--bauhaus-red)]">
                0{index + 1}
              </span>
              <h2 className="mt-12 text-2xl font-black uppercase tracking-[-0.03em]">
                {point.title}
              </h2>
              <p className="mt-4 leading-7 text-black/60">{point.description}</p>
            </article>
          ))}
        </div>
        <div className="mt-16 grid gap-8 border-l-[0.8rem] border-[var(--bauhaus-blue)] bg-white p-8 sm:grid-cols-[1fr_auto] sm:items-center sm:p-12">
          <p className="max-w-3xl text-3xl font-black uppercase leading-tight tracking-[-0.04em] sm:text-4xl">
            {content.outcome}
          </p>
          <Link
            className="border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-yellow)] px-5 py-4 text-center text-sm font-black uppercase tracking-[0.1em] shadow-[5px_5px_0_var(--bauhaus-ink)]"
            href="/download"
          >
            Install the app
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}
