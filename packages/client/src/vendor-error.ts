import { vendorLabel } from "@muon/protocol";
import { buildOnboardingState } from "./onboarding.js";
import { NO_PRINTABLE_TEXT, terminalSafe } from "./terminal-safe.js";
import type { VendorReadiness } from "./types.js";

/**
 * P6, graceful vendor-error handling (the shared classifier).
 *
 * When a dispatch/run fails, a fresh user must NOT see a cryptic stack dump.
 * This pure classifier turns "which vendor + what readiness + what error" into a
 * CLEAR, actionable notice that every surface (CLI/TUI/desktop) renders the same
 * way. It distinguishes the two failure modes the P6 brief calls out:
 *   - NOT CONNECTED (vendor not installed / not logged in, or the vendor CLI
 *     itself reports "please log in") → route the user to ONBOARDING and show the
 *     readiness `fixHint` (the exact command THEY run, never a token).
 *   - VENDOR RUN FAILED (the vendor is connected but the run errored) → show a
 *     clear, sanitized message and offer RETRY.
 *
 * TRUST DISCIPLINE: the `fixHint` is sourced verbatim from vendor-readiness,
 * which never contains a token; and `sanitizeVendorErrorMessage` collapses a
 * thrown error to its first line + strips anything token-shaped, so a raw dump
 * (or a stray bearer token) can never reach the message a user sees.
 */

export type VendorErrorKind = "not-ready" | "run-failed";

export type VendorErrorNotice = {
  kind: VendorErrorKind;
  vendor: string;
  /** Short, human headline (e.g. "Claude Code isn't connected"). */
  title: string;
  /** One-line actionable detail, sanitized, never a raw stack dump. */
  detail: string;
  /** The exact command the user runs to fix a connection gap. Never a token. */
  fixHint?: string;
  /** Where the surface should send the user next. */
  route: "onboarding" | "retry";
  /** True when re-running as-is might succeed (a run failure, not a setup gap). */
  retryable: boolean;
};

/**
 * An auth/login signal in a vendor CLI's OWN runtime error, the same family of
 * phrases the readiness prober keys on. A run that dies on one of these is a
 * "not logged in" situation even if a stale readiness snapshot said otherwise.
 */
const AUTH_FAILURE =
  /not (logged|signed)[ -]?in|logged out|signed out|please (log|sign) ?in|log ?in first|no (stored )?credential|not authenticated|unauthorized|401|authentication (failed|required)|invalid api key|missing api key|no api key/i;

/**
 * Anything token-shaped, redacted defensively before a message reaches a user.
 * Two passes so a long hex run (a MUON session token / API key) is caught even
 * when it abuts a word char, a trailing `\b` fails against `<64hex>_cache_miss`
 * (`x` to `_` is not a word boundary), leaking the token. The hex alternative
 * therefore carries NO `\b`; it matches a 32+ hex run greedily wherever it sits.
 * (Accepted cost: a 40-char git SHA in an error line also gets redacted, fine,
 * this is a sanitized, user-facing message, not a log we grep for SHAs.)
 */
const TOKEN_SHAPED_PREFIXED =
  /\b(sk-[A-Za-z0-9_-]{6,}|bearer\s+[A-Za-z0-9._-]{8,})/gi;
const TOKEN_SHAPED_HEX = /[A-Fa-f0-9]{32,}/g;

/** The raw error text from a thrown error / string, without a stack. */
function errorText(error: unknown): string {
  if (error == null) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Reduce a thrown error to a single clean line: first line only (drop any stack),
 * token-shaped substrings redacted, whitespace collapsed, and length-capped, so
 * no surface ever prints a raw dump or a leaked secret.
 */
export function sanitizeVendorErrorMessage(error: unknown): string {
  const firstLine = errorText(error).split("\n")[0] ?? "";
  // TERMINAL-SAFE FIRST (review pass 11 F3). This function is named
  // "sanitize" and every terminal surface trusted it to be one, but `\s+` in
  // JavaScript does NOT match ESC (U+001B), the C1 CSI (U+009B), or the bidi
  // overrides (U+202A–202E) — so an error body could carry SGR colour forgery
  // and a right-to-left reorder straight onto a status line. Measured against
  // a backend 500 whose message embedded all three: ESC, C1 and RLO all
  // survived and rendered, one of them painting attacker text in MUON's own
  // green. `terminalSafe` is the repo's single answer for that class, and it
  // runs BEFORE redaction and the cap so a control byte cannot split a
  // token-shaped match, and so the 240 budget counts characters a human can
  // actually see.
  const flattened = terminalSafe(firstLine);
  if (flattened === NO_PRINTABLE_TEXT) {
    // Every character was a control or format character. There is no message
    // here to show, and printing the placeholder as though it were the
    // vendor's words would be worse than the honest generic line.
    return "the vendor run failed";
  }
  const redacted = flattened
    .replace(TOKEN_SHAPED_PREFIXED, "[redacted]")
    .replace(TOKEN_SHAPED_HEX, "[redacted]");
  const collapsed = redacted.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "the vendor run failed";
  }
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}…` : collapsed;
}

/** A generic connect hint when no readiness `fixHint` is available. */
function genericConnectHint(vendor: string): string {
  switch (vendor) {
    case "claude-code":
      return "run `claude` and sign in (or set ANTHROPIC_API_KEY)";
    case "codex":
      return "run `codex login`";
    case "cursor":
      return "run `cursor-agent login`";
    default:
      return "connect this vendor via its own CLI login";
  }
}

/**
 * Classify a dispatch/run failure into an actionable notice.
 *
 * Order of resolution:
 *   1. Readiness says the vendor is NOT installed/authenticated → not-ready
 *      (route: onboarding, carry the readiness fixHint).
 *   2. A usable BYOK credential remains connected even when a vendor runtime
 *      emits native-login language → run-failed (route: retry).
 *   3. Other runtime auth/login failures → not-ready (route: onboarding).
 *   4. Otherwise the vendor is connected but the run failed → run-failed
 *      (route: retry, sanitized message).
 */
export function classifyVendorFailure(input: {
  vendor: string;
  readiness?: VendorReadiness[] | null;
  error?: unknown;
}): VendorErrorNotice {
  // `vendorLabel` falls through to the RAW vendor string for an id it does not
  // know (protocol/vendor.ts), and a lane key is stored text — so the title,
  // which every surface prints, was a second unsanitized path beside the
  // detail. Same for a readiness `fixHint`, which is stored per vendor.
  const label = terminalSafe(vendorLabel(input.vendor));
  const entry = (input.readiness ?? []).find(
    (item) => item.vendor === input.vendor
  );

  // 1, a setup gap from readiness.
  const readinessGap = Boolean(entry && !(entry.installed && entry.authenticated));
  const authError = AUTH_FAILURE.test(errorText(input.error));

  // 2, API-key and provider-owned credentials do not have a vendor-native
  // login state. Preserve their positive readiness evidence even if a child
  // runtime uses generic "not logged in" language for a credential failure.
  const usableByok =
    entry?.installed === true &&
    entry.authenticated === true &&
    (entry.credentialMethod === "api-key" ||
      entry.credentialMethod === "custom-provider" ||
      entry.credentialMethod === "local-provider");
  if (usableByok && authError) {
    return {
      kind: "run-failed",
      vendor: input.vendor,
      title: `${label} credential-backed run failed`,
      detail: `${label} has a usable configured credential; refresh that credential or retry.`,
      route: "retry",
      retryable: true,
    };
  }

  // 3, a native-login setup gap or runtime auth failure.
  if (readinessGap || authError) {
    const notInstalled = entry ? !entry.installed : false;
    const fixHint = entry?.fixHint
      ? terminalSafe(entry.fixHint)
      : genericConnectHint(input.vendor);
    return {
      kind: "not-ready",
      vendor: input.vendor,
      title: `${label} isn't connected`,
      detail: notInstalled
        ? `${label} isn't installed yet, connect it, then run your task.`
        : `${label} isn't signed in yet, connect it, then run your task.`,
      fixHint,
      route: "onboarding",
      retryable: false,
    };
  }

  // 4, the vendor is connected; this is a real run failure.
  return {
    kind: "run-failed",
    vendor: input.vendor,
    title: `${label} run failed`,
    detail: sanitizeVendorErrorMessage(input.error),
    route: "retry",
    retryable: true,
  };
}

/**
 * True when NO vendor is ready at all, the caller should route straight to
 * onboarding rather than attempting a dispatch that can only fail. A thin wrapper
 * over the shared onboarding machine so "ready" means one thing everywhere.
 */
export function noVendorReady(
  readiness: VendorReadiness[] | null | undefined
): boolean {
  return !buildOnboardingState(readiness).anyReady;
}
