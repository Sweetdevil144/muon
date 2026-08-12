/**
 * What counts as a cost cap — stated ONCE, for every surface that takes one
 * from a human (ADR-0036 D7).
 *
 * The rule used to live inside the CLI's `muon cost` command. The moment a
 * second surface accepted a cap (the desk, surface-parity item 4), a second
 * statement of it would have been the way the two came to disagree about what
 * a human typed — and the disagreement here is not cosmetic:
 *
 *  - ZERO IS REFUSED, never read as "clear". A cap of zero refuses every
 *    dispatch forever while reading, on every surface, like a configured
 *    limit. A human who types `0` meaning "no limit" would get the exact
 *    opposite of what they asked for, silently. `none` is how you clear it.
 *  - Negative and non-finite are refused for the same reason: they are not
 *    caps, and coercing them to something plausible invents a decision the
 *    human did not make.
 *
 * Returns a RESULT rather than throwing: a renderer needs a message to show
 * next to the field, and a thrown error there becomes an error boundary. The
 * CLI turns `ok: false` back into its own failure, so both surfaces refuse the
 * same inputs with the same words.
 */
export type ParsedCostCap =
  | { readonly ok: true; readonly capUsd: number | null }
  | { readonly ok: false; readonly message: string };

/** The backend's own ceiling (`z.number().positive().max(1_000_000)`). */
const MAX_CAP_USD = 1_000_000;

export function parseCostCapInput(raw: string): ParsedCostCap {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) {
    return {
      ok: false,
      message:
        "Give a positive dollar amount (e.g. 25), or 'none' to clear the cap.",
    };
  }
  if (value === "none" || value === "clear" || value === "off") {
    return { ok: true, capUsd: null };
  }
  const parsed = Number(value.replace(/^\$/, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      ok: false,
      message: `'${raw}' is not a cap. Give a positive dollar amount (e.g. 25), or 'none' to clear it. Zero is refused: it would block every dispatch while looking like a configured limit.`,
    };
  }
  if (parsed > MAX_CAP_USD) {
    // Refused HERE rather than by a 400 from the route, so the human sees the
    // ceiling beside the field instead of a rejected write.
    return {
      ok: false,
      message: `A cap above $${MAX_CAP_USD.toLocaleString("en-US")} is refused. Use 'none' if you mean no limit.`,
    };
  }
  return { ok: true, capUsd: parsed };
}
