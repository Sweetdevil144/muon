/**
 * The design tokens, read off the live DOM.
 *
 * WHY THIS EXISTS: the two graph surfaces (the Knowledge graph in
 * `graph-view.tsx` and the Memory graph in `memory-workspace.tsx`) paint into a
 * WebGL canvas via sigma. A canvas is unreachable from the stylesheet, so their
 * label, node and edge colours have to be handed over as literal strings when
 * the renderer is constructed. They were hardcoded to near-white
 * (`labelColor: "#F3F4F6"`), with comments claiming they were "tied to the
 * design token" — they were not, and on the light desk that painted near-white
 * labels onto a near-white canvas.
 *
 * Custom properties inherit, so `getComputedStyle` on any element inside `.app`
 * resolves whichever theme block is currently winning. Reading them here is what
 * actually ties the canvas to the same tokens the CSS uses, in both themes.
 */
import { useEffect, useRef, useState, type RefObject } from "react";

export type DeskTokens = {
  /** The canvas the graphs paint on. */
  bg: string;
  textPrimary: string;
  textTertiary: string;
  panel: string;
  border: string;
  borderStrong: string;
  accent: string;
};

/** Dark-theme values, used only before mount or in a non-DOM test context. */
export const DESK_TOKEN_FALLBACK: DeskTokens = {
  bg: "#141414",
  textPrimary: "#E8E8E8",
  textTertiary: "#6E6E6E",
  panel: "#181818",
  border: "#2A2A2A",
  borderStrong: "#3A3A3A",
  accent: "#82AAFF",
};

const TOKEN_PROPERTY: Record<keyof DeskTokens, string> = {
  bg: "--bg",
  textPrimary: "--text-primary",
  textTertiary: "--text-tertiary",
  panel: "--panel",
  border: "--border",
  borderStrong: "--border-strong",
  accent: "--accent",
};

export function readDeskTokens(el: Element | null | undefined): DeskTokens {
  if (!el || typeof getComputedStyle !== "function") return DESK_TOKEN_FALLBACK;
  const style = getComputedStyle(el);
  const out = { ...DESK_TOKEN_FALLBACK };
  for (const key of Object.keys(TOKEN_PROPERTY) as (keyof DeskTokens)[]) {
    // A token can resolve to "" when the stylesheet has not applied yet (and in
    // jsdom, which does not resolve custom properties at all) — keep the
    // fallback rather than handing sigma an empty string it will paint black.
    const value = style.getPropertyValue(TOKEN_PROPERTY[key]).trim();
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Track the tokens for `ref`'s element, re-reading when the desk theme flips.
 *
 * The theme is expressed as a `desk-light` class toggled on the `.app` root
 * (app.tsx), so that class attribute is the signal. Observing it means an open
 * graph repaints on toggle instead of waiting to be unmounted and rebuilt —
 * which would also throw away the viewer's camera position.
 */
export function useDeskTokens(ref: RefObject<HTMLElement | null>): DeskTokens {
  const [tokens, setTokens] = useState<DeskTokens>(DESK_TOKEN_FALLBACK);
  const latest = useRef(tokens);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const next = readDeskTokens(el);
      const changed = (Object.keys(next) as (keyof DeskTokens)[]).some(
        (k) => next[k] !== latest.current[k]
      );
      if (!changed) return;
      latest.current = next;
      setTokens(next);
    };
    sync();
    const root = el.closest(".app") ?? el.ownerDocument?.documentElement;
    if (!root || typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [ref]);

  return tokens;
}

/* ── categorical hues on a canvas the stylesheet cannot reach ────────────────
 *
 * The graph palettes encode MEANING by hue — a Class is amber, a Function is
 * green, a CONTAINS edge is one colour and a CALLS edge another — and they were
 * ported verbatim from GitNexus OSS, tuned for its near-black canvas. Re-hueing
 * them for light mode would fork a palette that is supposed to stay in step
 * with OSS, and would also break the one thing they are for: the same kind is
 * the same colour everywhere.
 *
 * So the hue is never replaced, only pushed toward or away from the canvas
 * until it is actually visible against it. WCAG 1.4.11 puts graphical objects
 * at 3:1, which is the floor used here — these are dots and lines, not text.
 * On the dark desk almost every hue already clears it and comes back
 * unchanged; the light desk is where the pale ones (grey-400 node fallback at
 * 2.2:1 on white) were disappearing.
 */

function channels(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function relativeLuminance(hex: string): number {
  const lin = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

const toHex = (v: number[]): string =>
  "#" +
  v
    .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
    .join("");

/** Minimum contrast for a graphical object (WCAG 1.4.11). */
export const GRAPHIC_CONTRAST_FLOOR = 3;

/**
 * Return `hue` adjusted just far enough to clear the floor against `canvas`,
 * preserving its hue. Already-legible colours are returned untouched, so the
 * dark desk keeps the OSS palette byte-for-byte.
 */
export function hueOnCanvas(
  hue: string,
  canvas: string,
  floor: number = GRAPHIC_CONTRAST_FLOOR
): string {
  if (!/^#[0-9a-f]{3,8}$/i.test(hue)) return hue;
  if (contrastRatio(hue, canvas) >= floor) return hue;
  const rgb = channels(hue);
  // Move AWAY from the canvas: darken on a light ground, lighten on a dark one.
  const darken = relativeLuminance(canvas) > 0.5;
  let best = hue;
  let bestRatio = contrastRatio(hue, canvas);
  for (let step = 1; step <= 100; step += 1) {
    const f = step / 100;
    const cand = toHex(
      darken ? rgb.map((c) => c * (1 - f)) : rgb.map((c) => c + (255 - c) * f)
    );
    const r = contrastRatio(cand, canvas);
    if (r > bestRatio) {
      bestRatio = r;
      best = cand;
    }
    if (r >= floor) return cand;
  }
  // Unreachable in practice; return the most legible candidate rather than
  // silently keeping an invisible one.
  return best;
}
