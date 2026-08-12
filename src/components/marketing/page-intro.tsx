import Link from "next/link";

type PageIntroProps = {
  eyebrow: string;
  title: string;
  intro: string;
  action?: {
    label: string;
    href: string;
  };
};

export function PageIntro({ eyebrow, title, intro, action }: PageIntroProps) {
  return (
    <section className="bauhaus-grid border-b-2 border-[var(--bauhaus-ink)]">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-[1fr_0.42fr] lg:items-end">
        <div>
          <p className="bauhaus-eyebrow">{eyebrow}</p>
          <h1 className="mt-6 max-w-5xl text-balance text-5xl font-black uppercase leading-[0.9] tracking-[-0.055em] sm:text-7xl lg:text-[6.5rem]">
            {title}
          </h1>
        </div>
        <div>
          <p className="text-pretty text-lg leading-8 text-black/65">{intro}</p>
          {action ? (
            <Link
              className="mt-7 inline-flex border-b-4 border-[var(--bauhaus-red)] pb-1 text-sm font-black uppercase tracking-[0.12em]"
              href={action.href}
            >
              {action.label} →
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
