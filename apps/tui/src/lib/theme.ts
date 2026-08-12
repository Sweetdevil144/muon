/** Flat charcoal HUB palette for Ink (ANSI-friendly). */
export const hub = {
  /** Structural selection/focus/affordance — cyan, never white. */
  focus: "cyan" as const,
  /** Success confirmations only. */
  accent: "green" as const,
  /** The sole needs-you colour: approvals, degraded, login-needed. */
  warn: "yellow" as const,
  muted: undefined,
  /** R3 TTL: a LAPSED item — withdrawn from circulation, not an error and not a
   *  warning, so it borrows neither red nor `warn` yellow. Grey reads
   *  "we stopped vouching for this", which is exactly what expiry means. */
  lapsed: "gray" as const,
  border: "gray" as const,
  borderFocus: "cyan" as const,
  /** Masthead only. */
  brand: "white" as const,
};

export const panelBorder = "round" as const;

/**
 * Parity/gate chip tone. Three tiers only: refusals red, needs-you yellow,
 * everything else undefined (the caller renders it dim). A capability chip is
 * not a success event, so green never appears here — and the footgun still
 * never looks safe (gated/needs-approval reads yellow, refused reads red).
 */
export function chipColor(chip: string | undefined): string | undefined {
  if (!chip) return undefined;
  if (/blocked|refused/.test(chip)) {
    return "red";
  }
  if (
    /gated|needs approval|needs egress|cloud|provenance|limited|needs-work|warn/.test(
      chip
    ) ||
    chip.includes("⚠")
  ) {
    return hub.warn;
  }
  return undefined;
}

/**
 * P0.5 capability-preflight tone: the ONE Doctor status → color mapping,
 * shared in spirit with the desktop DiagnosticsStrip. ready reads plain
 * (undefined, dim by default), degraded is the sole needs-you yellow,
 * blocked is the sole error red. Never green, a preflight is not a success
 * event.
 */
export function preflightTone(
  status: "ready" | "degraded" | "blocked"
): string | undefined {
  if (status === "blocked") return "red";
  if (status === "degraded") return hub.warn;
  return undefined;
}

/**
 * Status-line tone: the leading glyph decides. Loading (…) is dim, running
 * (▶ ■ →) and plain notices render plain, ✓ green, ✗ red, ⚠/gated yellow.
 */
export function statusTone(line: string): { color?: string; dim: boolean } {
  if (line.startsWith("✗")) return { color: "red", dim: false };
  if (line.startsWith("⚠") || line.startsWith("gated")) {
    return { color: hub.warn, dim: false };
  }
  if (line.startsWith("✓")) return { color: hub.accent, dim: false };
  if (line.startsWith("…")) return { dim: true };
  return { dim: false };
}
