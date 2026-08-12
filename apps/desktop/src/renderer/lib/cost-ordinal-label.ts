/** Relative cost tier from the registry ordinal (0…1) — never dollars. */
export function costOrdinalTier(ordinal: number): "low" | "mid" | "high" {
  if (ordinal <= 0.25) return "low";
  if (ordinal <= 0.55) return "mid";
  return "high";
}

/**
 * Compact provider/model picker label for a lane's relative cost ordinal.
 * The notice repeats the honest crew-level placeholder from the API.
 */
export function formatCostOrdinalLabel(
  ordinal: number,
  notice = "cost accounting not yet metered"
): string {
  const clamped = Math.min(1, Math.max(0, ordinal));
  return `cost · ${costOrdinalTier(clamped)} (${clamped.toFixed(1)}) · ${notice}`;
}
