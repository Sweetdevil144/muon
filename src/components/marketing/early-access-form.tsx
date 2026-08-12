"use client";

import { ArrowRight, Check } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

export function EarlyAccessForm({ compact = false }: { compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || status === "loading") return;

    setStatus("loading");
    setError("");

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), website }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };

      if (response.ok && body.ok) {
        setStatus("success");
        return;
      }

      setStatus("error");
      setError(body.error || "Something went wrong. Please try again.");
    } catch {
      setStatus("error");
      setError("Network error. Please try again.");
    }
  };

  if (status === "success") {
    return (
      <div
        className="flex min-h-14 items-center gap-3 border-2 border-[var(--bauhaus-ink)] bg-white px-4 text-sm font-bold"
        role="status"
      >
        <span className="grid size-7 place-items-center rounded-full bg-[var(--bauhaus-blue)] text-white">
          <Check className="size-4" />
        </span>
        You’re on the list. We’ll be in touch.
      </div>
    );
  }

  return (
    <form
      className={`grid gap-2 ${compact ? "sm:grid-cols-[1fr_auto]" : "sm:grid-cols-[minmax(0,1fr)_auto]"}`}
      onSubmit={submit}
    >
      <input
        aria-hidden="true"
        autoComplete="off"
        className="pointer-events-none absolute left-[-9999px] size-0 opacity-0"
        name="website"
        onChange={(event) => setWebsite(event.target.value)}
        tabIndex={-1}
        type="text"
        value={website}
      />
      <label className="sr-only" htmlFor={compact ? "pricing-email" : "home-email"}>
        Work email
      </label>
      <input
        className="min-h-14 min-w-0 border-2 border-[var(--bauhaus-ink)] bg-white px-4 text-base outline-none placeholder:text-black/40 focus-visible:shadow-[inset_0_0_0_3px_var(--bauhaus-yellow)]"
        disabled={status === "loading"}
        id={compact ? "pricing-email" : "home-email"}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@company.com"
        required
        type="email"
        value={email}
      />
      <button
        className="inline-flex min-h-14 items-center justify-center gap-2 border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-blue)] px-5 text-sm font-black uppercase tracking-[0.1em] text-white shadow-[5px_5px_0_var(--bauhaus-ink)] transition hover:-translate-y-0.5 hover:shadow-[7px_7px_0_var(--bauhaus-ink)] disabled:opacity-60"
        disabled={status === "loading"}
        type="submit"
      >
        {status === "loading" ? "Joining…" : "Get release updates"}
        <ArrowRight aria-hidden="true" className="size-4" />
      </button>
      {status === "error" ? (
        <p className="text-sm font-semibold text-[var(--bauhaus-red)] sm:col-span-2" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
