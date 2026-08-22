"use client";

import { useState } from "react";

import { SiteShell } from "@/components/muon/SiteShell";
import { PageHero, NumberedList } from "@/components/muon/PageHero";

// The 2026-08-23 marketing appendix: this is a sales page for Linked
// Operation, not a generic enterprise mood. Each block is a fact with a
// limit, and the honest limit is stated in public — that is how this
// product earns trust.
const FIT = [
  {
    title: "Strong fit",
    description:
      "Two to N engineers who already run vendor CLIs and need a shared, confirmed memory rather than a Slack channel of agent output. You keep your Claude Code, Codex, Cursor, and OpenCode accounts; MUON links the instances around them.",
  },
  {
    title: "How teams start",
    description:
      "Each person installs Individual — it is complete and free for one person, employer laptops included. Linking those instances so they share memory, graphs, crews, claims, or findings is the licensed step, priced per named person who is linked.",
  },
  {
    title: "The honest limit",
    description:
      "Company tenancy, stewards, and a managed organisation ledger are not in this conversation yet. We will not sell you SOC 2, SSO, or a hosted org brain today, and we will not ask you to move your repository into our cloud to buy what we do sell.",
  },
];

const FIELDS = [
  { label: "Full name", type: "text", name: "fullName" },
  { label: "Role", type: "text", name: "role" },
  { label: "Company", type: "text", name: "company" },
  { label: "Company email", type: "email", name: "companyEmail" },
];

function EnterprisePage() {
  // The prototype shipped `onSubmit={(e) => e.preventDefault()}` — a form that
  // looks identical and drops every lead on the floor. This posts to the route
  // that was already live and already validating.
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("sending");
    setError(null);
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const res = await fetch("/api/enterprise-contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        // Show the route's own reason: "invalid email" is fixable by the
        // person reading it, a generic failure is not.
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? null);
        setState("error");
        return;
      }
      form.reset();
      setState("sent");
    } catch {
      setState("error");
    }
  }

  return (
    <SiteShell>
      <PageHero
        eyebrow="Teams"
        title="The second person on the brain is the product we license."
        intro="Individual MUON is one person's desk. Teams starts at the moment two instances share memory, graphs, crews, claims, or findings — including if you host the link yourselves. We will not ask you to move the repository into our cloud in order to buy that."
      />

      <section className="border-b border-border py-20 lg:py-28">
        <NumberedList items={FIT} />
      </section>

      <section className="py-20 lg:py-28">
        <div className="grid grid-cols-12 gap-8">
          <div className="col-span-12 lg:col-span-5">
            <h2 className="mb-4 font-sans text-[1.75rem] font-semibold tracking-[-0.02em]">
              Start a Teams conversation
            </h2>
            <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
              Tell us how your team uses coding agents today, how many people would link their
              instances, and which security or deployment constraints matter most. Until checkout
              ships, this conversation is how Linked Operation is priced — per named linked
              person, in the open.
            </p>
            <a href="https://cal.com/abhinavpandey/30min" className="mt-6 inline-block btn-ghost">
              Or talk to the founder →
            </a>
          </div>

          <form
            className="panel col-span-12 grid grid-cols-1 gap-4 p-8 sm:grid-cols-2 lg:col-span-7"
            onSubmit={onSubmit}
          >
            {FIELDS.map((field) => (
              <label key={field.name} className="flex flex-col gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  {field.label}
                </span>
                <input
                  type={field.type}
                  name={field.name}
                  className="border border-border bg-transparent px-3 py-2.5 text-sm text-foreground outline-none focus:border-muon-blue"
                />
              </label>
            ))}
            <label className="flex flex-col gap-2 sm:col-span-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                What problem are you trying to solve?
              </span>
              <textarea
                name="problemDescription"
                rows={4}
                className="border border-border bg-transparent px-3 py-2.5 text-sm text-foreground outline-none focus:border-muon-blue"
              />
            </label>
            {/* Honeypot: real people never fill this, and the route answers ok
                to anything that does, so a bot learns nothing from the reply. */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="hidden"
            />
            <button
              type="submit"
              disabled={state === "sending"}
              className="btn-primary sm:col-span-2 disabled:opacity-60"
            >
              {state === "sending" ? "Sending\u2026" : "Send"}
            </button>
            {state === "sent" ? (
              <p role="status" className="sm:col-span-2 text-sm text-trust-crew">
                Thanks \u2014 that reached us.
              </p>
            ) : null}
            {state === "error" ? (
              <p role="alert" className="sm:col-span-2 text-sm text-trust-unconfirmed">
                {error ?? "That did not send."} You can also mail{" "}
                <a className="underline" href="mailto:abhinavpandey1230@gmail.com">
                  abhinavpandey1230@gmail.com
                </a>
                .
              </p>
            ) : null}
          </form>
        </div>
      </section>
    </SiteShell>
  );
}

export default EnterprisePage;
