/**
 * ONE place that turns "which model is this running on?" into words.
 *
 * The original answer was the literal string "Vendor default", which is a fact
 * about MUON (it named no model) dressed up as an answer about the agent. Three
 * different surfaces printed it, so three surfaces were wrong in the same way.
 *
 * D2 replaced its first fix, which over-corrected into a negative: the menu row
 * read `Let Claude Code choose · Not reported by Claude Code` — the vendor named
 * twice, and a denial planted inside what is supposed to be an affirmative
 * choice. The rule that replaces it:
 *
 *   The ACTION is the label. What it currently resolves to is SUPPORTING
 *   DETAIL, appended only when there is a detail to append.
 *
 * The rules, in order, and identical on every surface:
 *   1. MUON named a model for this run          → print that model.
 *   2. The vendor's own config named one        → print it, marked as the
 *      VENDOR's default, with the exact file or command as provenance.
 *   3. Nobody named one                         → say who picks ("Claude Code
 *      picks"), which is true and is not an error, and say WHY on hover.
 *
 * There is no branch that prints a model name MUON did not receive from either
 * the dispatch record or the vendor's own configuration.
 */

import { vendorLabel } from "@muon/client/vendors";
import type { VendorModelResolutionIpc } from "../../shared/ipc.js";

export type ModelDisplay = {
  /** Full label for a menu row / meta cell. */
  text: string;
  /** The same answer squeezed for a narrow trigger. */
  compact: string;
  /** Provenance, for the `title` attribute. Always says where `text` came from. */
  title: string;
  /** True when `text` is a real model name (not a statement about who picks). */
  resolved: boolean;
  /**
   * The bare model name when one is known, else null. This is what a caller
   * composes into its own sentence; it is NEVER a placeholder, so a caller that
   * appends it cannot accidentally append "Vendor default" or "Not reported".
   */
  model: string | null;
};

export function modelDisplay(input: {
  /** The model MUON dispatched with, when it named one. */
  explicitModel?: string | null;
  /**
   * The vendor id. The LABEL is derived from it here rather than passed
   * alongside it — passing both let a caller hand over vendor A's id with
   * vendor B's label, which is the same one-fact-two-answers drift this module
   * exists to prevent.
   */
  vendor: string;
  /** The vendor's own report, or null when MUON has not asked / the ask failed. */
  resolution: VendorModelResolutionIpc | null;
  /** A probe is in flight — never render a verdict while still asking. */
  resolving?: boolean;
}): ModelDisplay {
  const label = vendorLabel(input.vendor);
  const explicit = input.explicitModel?.trim();
  if (explicit) {
    return {
      text: explicit,
      compact: explicit,
      title: `MUON dispatched this run with ${explicit}.`,
      resolved: true,
      model: explicit,
    };
  }
  if (input.resolving) {
    return {
      text: "Resolving…",
      compact: "Resolving…",
      title: `Asking ${label} which model it will run.`,
      resolved: false,
      model: null,
    };
  }
  // A resolution for a DIFFERENT vendor is not an answer about this one. Two
  // surfaces sharing one resolution map is how the Crew page and the composer
  // stay in step; this guard is what stops that sharing from turning into one
  // vendor's model printed under another's name.
  const resolution =
    input.resolution && input.resolution.vendor === input.vendor
      ? input.resolution
      : null;
  if (resolution?.state === "reported" && resolution.model) {
    return {
      text: `${resolution.model} · ${label} default`,
      compact: resolution.model,
      title: `MUON named no model, so ${label} picks. Resolved to "${
        resolution.model
      }"${resolution.probe ? ` from \`${resolution.probe}\`` : ""}.`,
      resolved: true,
      model: resolution.model,
    };
  }
  // Affirmative, and still honest: it states who decides, and `resolved: false`
  // plus the title state that MUON does not know what they will decide.
  const whoPicks = `${label} picks`;
  return {
    text: whoPicks,
    compact: whoPicks,
    title: `MUON named no model for this run, so ${label} picks — and MUON has no report of which model that is. ${
      resolution?.reason ?? `Nothing has reported a model for ${label}.`
    }`,
    resolved: false,
    model: null,
  };
}

/**
 * The same answer, squeezed for the composer trigger, which is a single narrow
 * row. It drops the provenance suffix but never the honesty: an unresolved
 * model reads "<vendor> picks", never "Auto" and never a model name.
 */
export function compactModelLabel(display: ModelDisplay): string {
  return display.compact;
}

/**
 * The "let the vendor pick" row, on every surface that offers it (the composer's
 * Model panel, the Crew page's Orchestrator Model select).
 *
 * The action stands alone and reads as a choice. The resolved model is appended
 * only when MUON actually has one, so this renders:
 *
 *     Let Claude Code choose · opus[1m]      (resolved)
 *     Let Claude Code choose                 (not resolved, or still resolving)
 *
 * and never the vendor's name twice, and never a negative inside an affirmative.
 *
 * `display` MUST be built with `explicitModel` omitted: this row describes what
 * happens when NO model is named, so feeding it a display that already carries
 * the user's explicit pick would advertise that pick as the vendor's choice.
 */
export function vendorChoiceLabel(
  vendor: string,
  display: ModelDisplay
): string {
  const action = `Let ${vendorLabel(vendor)} choose`;
  return display.model ? `${action} · ${display.model}` : action;
}
