import Link from "next/link";

const TRUST = [
  {
    title: "Your work stays on your machine",
    description:
      "MUON runs locally. The core loop does not depend on sending your engineering process through someone else's cloud.",
  },
  {
    title: "Permission stays narrow",
    description:
      "Approvals cover a specific action for a specific job. Shipping and other high-impact steps always come back to a person.",
  },
  {
    title: "Delivery stays reviewable",
    description:
      "What changed, what was checked and who decided stay attached to the mission, so you are not reconstructing the story later.",
  },
];

export function TrustClose() {
  return (
    <section id="install" className="border-t border-border py-20 lg:py-28">
      <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-3">
        {TRUST.map((item) => (
          <div key={item.title} className="panel p-6">
            <h3 className="mb-3 font-sans text-lg font-semibold tracking-[-0.01em]">
              {item.title}
            </h3>
            <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
              {item.description}
            </p>
          </div>
        ))}
      </div>

      <div
        className="panel flex flex-col items-start justify-between gap-6 p-8 lg:flex-row lg:items-center lg:p-12"
        style={{
          backgroundImage:
            "radial-gradient(circle at top right, color-mix(in oklab, var(--muon-blue) 16%, transparent), transparent 60%)",
        }}
      >
        <div className="max-w-xl">
          <h2 className="mb-3 font-sans text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] lg:text-4xl">
            Give your agents one mission. Let MUON run the crew.
          </h2>
          <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
            Runs on your machine with your own tool logins. The source is public, and the
            Individual Use Grant covers one person&apos;s use at no charge — including work you do
            for an employer.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <Link href="/download" className="btn-primary w-full">
            Install the app
          </Link>
          <a href="https://cal.com/abhinavpandey/30min" className="btn-ghost w-full">
            Talk to the founder
          </a>
        </div>
      </div>
    </section>
  );
}
