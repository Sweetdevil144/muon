import Link from "next/link";
import type { ReactNode } from "react";

export function PageHero({
  eyebrow,
  title,
  intro,
  cta,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  cta?: { label: string; to: string };
  children?: ReactNode;
}) {
  return (
    <section className="border-b border-border  py-20 lg:py-28 lg:py-24">
      <p className="panel-label mb-4">{eyebrow}</p>
      <h1 className="mb-5 max-w-[22ch] font-sans text-4xl font-semibold leading-[1.08] tracking-[-0.03em] lg:text-[3.25rem]">
        {title}
      </h1>
      <p className="max-w-[62ch] text-base leading-relaxed text-muted-foreground lg:text-lg">
        {intro}
      </p>
      {cta ? (
        <Link href={cta.to} className="mt-7 inline-block btn-ghost">
          {cta.label} →
        </Link>
      ) : null}
      {children}
    </section>
  );
}

export function NumberedList({ items }: { items: { title: string; description: string }[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {items.map((item, i) => (
        <div key={item.title} className="panel p-6">
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {String(i + 1).padStart(2, "0")}
          </div>
          <h3 className="mb-2 font-sans text-lg font-semibold tracking-[-0.01em]">{item.title}</h3>
          <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
            {item.description}
          </p>
        </div>
      ))}
    </div>
  );
}

export function SectionHead({
  eyebrow,
  title,
  note,
}: {
  eyebrow: string;
  title: string;
  note?: string;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="panel-label mb-3">{eyebrow}</p>
        <h2 className="max-w-[26ch] font-sans text-[1.75rem] font-semibold tracking-[-0.02em] lg:text-4xl">
          {title}
        </h2>
      </div>
      {note ? (
        <p className="max-w-[46ch] text-[0.9375rem] leading-relaxed text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}
