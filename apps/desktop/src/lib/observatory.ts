import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OBSERVATORY_UPLOAD_PROVIDER } from "./observatory-upload.js";

/**
 * P0-5 — the Observatory, local half.
 *
 * What ships here: a bounded event vocabulary, a consent gate, and a local
 * 0600 spool.
 *
 * HISTORY, because this docstring was wrong for a while and the wrongness was
 * the point of the field below: it used to say "What deliberately does NOT
 * ship: any uploader … MUON has no telemetry endpoint at all". ADR-0031 then
 * landed `observatory-upload.ts`, a real consent-gated PostHog uploader — and
 * this module went on stamping `provider: "none"` on every spooled record.
 * That made the audit artifact contradict the actual destination, which is the
 * one thing an audit artifact may never do.
 *
 * `OBSERVATORY_PROVIDER` now names the CONFIGURED destination, read from the
 * uploader itself so there is one truth rather than two constants. It is not a
 * statement that any given record left the machine: egress still requires
 * `settings.telemetryEnabled`, and the `MUON_OBSERVATORY_SPOOL` audit override
 * records locally while uploading nothing.
 *
 * The spool exists for two reasons:
 *  1. It IS the launch-checklist audit artifact (§11.2: "capture the final
 *     payload locally and audit every field before production enablement") —
 *     the exact bytes a future uploader would send, inspectable today.
 *  2. Crash records are useful to the OPERATOR locally (support requests)
 *     even with no telemetry at all.
 *
 * PRIVACY BY SHAPE, not by review: no event carries a free-text field. Every
 * field is an enum from this file, a number, a boolean, or the app version.
 * There is nowhere to put a path, a prompt, a repo name, or a token — a new
 * field means editing the positive vocabulary below, which is the review
 * point. (§11.2's forbidden list is satisfied structurally.)
 */

export const OBSERVATORY_PROVIDER = OBSERVATORY_UPLOAD_PROVIDER;

/** Bumped ONLY when an event's shape changes; stamped on every record so a
 *  future uploader (and today's local summary) can trust what it parses. */
export const OBSERVATORY_SCHEMA_VERSION = 1 as const;

/** Coarse crash reasons — Electron's `render-process-gone` reasons collapsed
 *  to a closed set so the field can never smuggle prose. */
export const CRASH_REASONS = [
  "crashed",
  "oom",
  "killed",
  "launch-failed",
  "integrity-failure",
  "clean-exit",
  "abnormal-exit",
  "unknown",
] as const;
export type CrashReason = (typeof CRASH_REASONS)[number];

export function coarseCrashReason(raw: string | undefined): CrashReason {
  const value = (raw ?? "").trim().toLowerCase();
  return (CRASH_REASONS as readonly string[]).includes(value)
    ? (value as CrashReason)
    : "unknown";
}

/** The WHOLE event vocabulary. Adding an event = adding a branch here. */
export type ObservatoryEvent =
  | { name: "app.launch"; coldStartMs?: number }
  | { name: "app.crash.renderer"; reason: CrashReason }
  | { name: "app.crash.main"; reason: "uncaught-exception" }
  | { name: "update.check"; updateAvailable: boolean }
  | { name: "update.applied" }
  // Consent lifecycle: granted lands as the FIRST row of a consenting spool.
  // (Revocation cannot land — a disabled spool records nothing — so absence
  // after a granted row IS the revocation record.)
  | { name: "consent.granted" }
  // Activation funnel: each fires at most ONCE per profile, ever.
  | { name: "funnel.first_vendor_ready" }
  | { name: "funnel.first_chat" }
  | { name: "funnel.first_dispatch" }
  | { name: "funnel.first_merge" };

const FUNNEL_EVENTS = new Set([
  "funnel.first_vendor_ready",
  "funnel.first_chat",
  "funnel.first_dispatch",
  "funnel.first_merge",
]);

/** What actually lands in the spool: the event + bounded build coordinates. */
export type ObservatoryRecord = ObservatoryEvent & {
  at: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  provider: typeof OBSERVATORY_PROVIDER;
  schema: typeof OBSERVATORY_SCHEMA_VERSION;
};

const SPOOL_MAX_BYTES = 512 * 1024;

export type ObservatoryOptions = {
  /** The profile's userData dir; the spool lives under `<dataDir>/observatory`. */
  dataDir: string;
  appVersion: string;
  /** Consent, read LIVE per event: `settings.telemetryEnabled` (default OFF)
   *  or the MUON_OBSERVATORY_SPOOL=1 audit override. OFF → record() is a
   *  complete no-op: no directory, no file, no bytes. */
  enabled: () => boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => Date;
  /** ADR-0031: called AFTER a row lands in the local spool (the uploader's
   *  tap). Consent was already checked by `enabled()`; the hook must never
   *  throw into record(). */
  onRecord?: (row: ObservatoryRecord) => void;
};

export type Observatory = {
  /** Append one event to the local spool (no-op without consent). Never
   *  throws: diagnostics loss must never break the app. */
  record(event: ObservatoryEvent): void;
  /** The spool path, for the Settings surface to name honestly. */
  spoolPath: string;
};

export function createObservatory(options: ObservatoryOptions): Observatory {
  const dir = join(options.dataDir, "observatory");
  const spoolPath = join(dir, "spool.jsonl");
  const milestonesPath = join(dir, "milestones.json");

  // Loaded from disk ONCE (lazily), then kept in the closure: the funnel
  // hooks sit on the 2s state poll, and re-reading the file per record meant
  // three synchronous reads every tick once consent was on.
  let milestones: Record<string, string> | null = null;
  const loadMilestones = (): Record<string, string> => {
    if (milestones) return milestones;
    try {
      const parsed = JSON.parse(readFileSync(milestonesPath, "utf8")) as unknown;
      milestones =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      milestones = {};
    }
    return milestones;
  };

  const record = (event: ObservatoryEvent): void => {
    try {
      if (!options.enabled()) return;
      if (FUNNEL_EVENTS.has(event.name)) {
        const known = loadMilestones();
        if (known[event.name]) return; // once per profile, ever
        known[event.name] = (options.now?.() ?? new Date()).toISOString();
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(milestonesPath, JSON.stringify(known, null, 2), {
          mode: 0o600,
        });
      }
      const row: ObservatoryRecord = {
        ...event,
        at: (options.now?.() ?? new Date()).toISOString(),
        appVersion: options.appVersion,
        platform: options.platform ?? process.platform,
        arch: options.arch ?? process.arch,
        provider: OBSERVATORY_PROVIDER,
        schema: OBSERVATORY_SCHEMA_VERSION,
      };
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Size cap: one rotation generation is plenty for an audit artifact.
      try {
        if (statSync(spoolPath).size > SPOOL_MAX_BYTES) {
          renameSync(spoolPath, `${spoolPath}.1`);
        }
      } catch {
        /* no spool yet */
      }
      appendFileSync(spoolPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      options.onRecord?.(row);
    } catch {
      // Diagnostics loss is never app breakage.
    }
  };

  return { record, spoolPath };
}

// ---------------------------------------------------------------------------
// Local analytics (F3): aggregate the spool into counts + the funnel, for the
// Settings surface. COUNTS AND TIMESTAMPS ONLY — the summary never carries an
// event row through, so it cannot leak more than the shape-bounded spool
// itself. Reads both rotation generations; tolerates a torn/partial line.
// ---------------------------------------------------------------------------

export type ObservatorySummary = {
  schema: typeof OBSERVATORY_SCHEMA_VERSION;
  provider: typeof OBSERVATORY_PROVIDER;
  spoolBytes: number;
  launches: number;
  crashes: Partial<Record<CrashReason | "uncaught-exception", number>>;
  updateChecks: number;
  updatesApplied: number;
  consentGrantedAt?: string;
  funnel: {
    first_vendor_ready?: string;
    first_chat?: string;
    first_dispatch?: string;
    first_merge?: string;
  };
};

export function summarizeObservatory(dataDir: string): ObservatorySummary {
  const dir = join(dataDir, "observatory");
  const summary: ObservatorySummary = {
    schema: OBSERVATORY_SCHEMA_VERSION,
    provider: OBSERVATORY_PROVIDER,
    spoolBytes: 0,
    launches: 0,
    crashes: {},
    updateChecks: 0,
    updatesApplied: 0,
    funnel: {},
  };
  for (const file of ["spool.jsonl.1", "spool.jsonl"]) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    summary.spoolBytes += Buffer.byteLength(text);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: Partial<ObservatoryRecord>;
      try {
        row = JSON.parse(line) as Partial<ObservatoryRecord>;
      } catch {
        continue; // torn tail line from a crash mid-append
      }
      switch (row.name) {
        case "app.launch":
          summary.launches += 1;
          break;
        case "app.crash.renderer":
        case "app.crash.main": {
          const reason = (row as { reason?: string }).reason ?? "unknown";
          const key = reason as keyof ObservatorySummary["crashes"];
          summary.crashes[key] = (summary.crashes[key] ?? 0) + 1;
          break;
        }
        case "update.check":
          summary.updateChecks += 1;
          break;
        case "update.applied":
          summary.updatesApplied += 1;
          break;
        case "consent.granted":
          summary.consentGrantedAt ??= row.at;
          break;
        default:
          break;
      }
    }
  }
  try {
    const milestones = JSON.parse(
      readFileSync(join(dir, "milestones.json"), "utf8")
    ) as Record<string, string>;
    summary.funnel = {
      first_vendor_ready: milestones["funnel.first_vendor_ready"],
      first_chat: milestones["funnel.first_chat"],
      first_dispatch: milestones["funnel.first_dispatch"],
      first_merge: milestones["funnel.first_merge"],
    };
  } catch {
    /* no milestones yet */
  }
  return summary;
}
