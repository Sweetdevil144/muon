/**
 * TODO 7.10 — stable principal → colour mapping.
 *
 * Stolen shape from the competitor's MIT agent-native kit (`principalColor`):
 * one opaque id always paints the same hue across inbox, presence, and stream
 * chrome so a human can track a crew member without reading the handle twice.
 * Full 55-component import is not required for the win; this is the piece
 * every MUON surface actually needed.
 */

function hashPrincipal(principal: string): number {
  let h = 2166136261;
  for (let i = 0; i < principal.length; i += 1) {
    h ^= principal.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** HSL string, saturation/lightness fixed for dark/light UI readability. */
export function principalColor(
  principal: string,
  opts?: { saturation?: number; lightness?: number }
): string {
  const key = principal.trim().length > 0 ? principal.trim() : "unknown";
  const hue = hashPrincipal(key) % 360;
  const s = opts?.saturation ?? 62;
  const l = opts?.lightness ?? 52;
  return `hsl(${hue} ${s}% ${l}%)`;
}

/** CSS custom-property friendly token (`--principal-abc123`). */
export function principalColorVar(principal: string): string {
  const slug = principal
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `--principal-${slug || "unknown"}`;
}
