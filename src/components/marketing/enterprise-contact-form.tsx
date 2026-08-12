"use client";

import { ArrowRight, Check } from "lucide-react";
import type { ChangeEvent, FormEvent } from "react";
import { useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

type FormState = {
  fullName: string;
  role: string;
  company: string;
  companyEmail: string;
  phoneNumber: string;
  problemDescription: string;
  website: string;
};

const initialForm: FormState = {
  fullName: "",
  role: "",
  company: "",
  companyEmail: "",
  phoneNumber: "",
  problemDescription: "",
  website: "",
};

const fieldClassName =
  "min-h-12 w-full border-2 border-[var(--bauhaus-ink)] bg-white px-4 text-base outline-none placeholder:text-black/35 focus-visible:shadow-[inset_0_0_0_3px_var(--bauhaus-yellow)] disabled:opacity-60";

export function EnterpriseContactForm() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const update =
    (key: keyof FormState) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((current) => ({ ...current, [key]: event.target.value }));
    };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "loading") return;

    setStatus("loading");
    setError("");

    try {
      const response = await fetch("/api/enterprise-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: form.fullName.trim(),
          role: form.role.trim(),
          company: form.company.trim(),
          companyEmail: form.companyEmail.trim(),
          phoneNumber: form.phoneNumber.trim() || undefined,
          problemDescription: form.problemDescription.trim(),
          website: form.website,
        }),
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
        className="flex min-h-40 items-center gap-4 border-2 border-[var(--bauhaus-ink)] bg-white p-6 text-base font-bold sm:p-8"
        role="status"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--bauhaus-blue)] text-white">
          <Check className="size-5" />
        </span>
        <div>
          <p>Thanks. We received your note.</p>
          <p className="mt-2 text-sm font-semibold text-black/55">
            Someone from MUON will follow up about the right setup for your team.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <input
        aria-hidden="true"
        autoComplete="off"
        className="pointer-events-none absolute left-[-9999px] size-0 opacity-0"
        name="website"
        onChange={update("website")}
        tabIndex={-1}
        type="text"
        value={form.website}
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="grid gap-2">
          <span className="text-xs font-black uppercase tracking-[0.14em] text-black/55">
            Full name
          </span>
          <input
            autoComplete="name"
            className={fieldClassName}
            disabled={status === "loading"}
            name="fullName"
            onChange={update("fullName")}
            required
            type="text"
            value={form.fullName}
          />
        </label>
        <label className="grid gap-2">
          <span className="text-xs font-black uppercase tracking-[0.14em] text-black/55">
            Role
          </span>
          <input
            autoComplete="organization-title"
            className={fieldClassName}
            disabled={status === "loading"}
            name="role"
            onChange={update("role")}
            required
            type="text"
            value={form.role}
          />
        </label>
      </div>

      <label className="grid gap-2">
        <span className="text-xs font-black uppercase tracking-[0.14em] text-black/55">
          Company
        </span>
        <input
          autoComplete="organization"
          className={fieldClassName}
          disabled={status === "loading"}
          name="company"
          onChange={update("company")}
          required
          type="text"
          value={form.company}
        />
      </label>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="grid gap-2">
          <span className="text-xs font-black uppercase tracking-[0.14em] text-black/55">
            Company email
          </span>
          <input
            autoComplete="email"
            className={fieldClassName}
            disabled={status === "loading"}
            name="companyEmail"
            onChange={update("companyEmail")}
            required
            type="email"
            value={form.companyEmail}
          />
        </label>
        <label className="grid gap-2">
          <span className="text-xs font-black uppercase tracking-[0.14em] text-black/55">
            Phone number
          </span>
          <input
            autoComplete="tel"
            className={fieldClassName}
            disabled={status === "loading"}
            name="phoneNumber"
            onChange={update("phoneNumber")}
            type="tel"
            value={form.phoneNumber}
          />
        </label>
      </div>

      <label className="grid gap-2">
        <span className="text-xs font-black uppercase tracking-[0.14em] text-black/55">
          What problem are you trying to solve?
        </span>
        <textarea
          className={`${fieldClassName} min-h-36 resize-y py-3`}
          disabled={status === "loading"}
          name="problemDescription"
          onChange={update("problemDescription")}
          required
          value={form.problemDescription}
        />
      </label>

      <div className="flex flex-wrap items-center gap-4">
        <button
          className="inline-flex min-h-14 items-center justify-center gap-2 border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-ink)] px-6 text-sm font-black uppercase tracking-[0.1em] text-white shadow-[5px_5px_0_var(--bauhaus-blue)] transition hover:-translate-y-0.5 hover:shadow-[7px_7px_0_var(--bauhaus-blue)] disabled:opacity-60"
          disabled={status === "loading"}
          type="submit"
        >
          {status === "loading" ? "Sending…" : "Send"}
          <ArrowRight aria-hidden="true" className="size-4" />
        </button>
        {status === "error" ? (
          <p className="text-sm font-semibold text-[var(--bauhaus-red)]" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
