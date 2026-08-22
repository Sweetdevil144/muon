/**
 * Dark/light parity for the desk themes.
 *
 * The bug class this exists to stop: a colour token is defined for the dark
 * desk and never redefined for the light one, or a rule hardcodes a colour the
 * light block structurally cannot re-point. Both are invisible in dark mode and
 * only surface when someone flips the theme — which is exactly how the light
 * desk ended up with near-white labels on a white canvas, a black composer box,
 * white-on-#ECEEF1 hover text, and 50%-black modal shadows on white.
 *
 * The theme-invariant set is an explicit ALLOWLIST, never `ALL − varying`.
 * Deriving it by subtraction is the failure this repo has already shipped three
 * times: a newly added token would land in the exempt set by default, which is
 * the silent direction. A new token is theme-varying until someone says
 * otherwise here, in writing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(
  fileURLToPath(new URL("../src/renderer/styles.css", import.meta.url)),
  "utf8"
);

/** Tokens that are deliberately the SAME in both themes. Each needs a reason. */
const THEME_INVARIANT = new Set([
  // Consoles (a terminal, a job log) stay dark in both themes, so their
  // foreground must NOT flip — that is the whole point of these existing.
  "--console-bg",
  "--console-rule",
  "--console-edge",
  "--console-edge-lit",
  "--on-console",
  "--on-console-2",
  "--on-console-3",
]);

function blockBody(selector: string): string {
  const start = CSS.indexOf(selector + " {");
  expect(start, `${selector} block not found`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < CSS.length; i += 1) {
    if (CSS[i] === "{") depth += 1;
    else if (CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error(`${selector} block never closed`);
}

const DARK = blockBody(":root");
const LIGHT = blockBody(".app.desk-light");

/** `--x: <value>;` declarations, first definition wins. */
function tokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    if (!out.has(m[1])) out.set(m[1], m[2].trim());
  }
  return out;
}

const COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;

/** A colour that is NOT expressed through a token. `color-mix(in srgb,
 *  var(--x) 8%, var(--y))` is fine — it follows whatever the tokens resolve to
 *  — so strip `var(...)` before looking for a raw literal. */
function hardcodesColour(text: string): boolean {
  return COLOUR.test(text.replace(/var\(\s*--[a-z0-9-]+\s*\)/gi, ""));
}

describe("desk theme parity", () => {
  const dark = tokens(DARK);
  const light = tokens(LIGHT);

  it("every colour token the dark desk defines is answered by the light desk", () => {
    const missing: string[] = [];
    for (const [name, value] of dark) {
      if (THEME_INVARIANT.has(name)) continue;
      // An alias (`--x: var(--y)`) follows whatever --y resolves to, so it
      // needs no light counterpart; only a literal colour does.
      if (!COLOUR.test(value)) continue;
      if (value.startsWith("var(")) continue;
      if (!light.has(name)) missing.push(`${name}: ${value}`);
    }
    expect(missing, "defined for dark, never for light").toEqual([]);
  });

  it("the theme-invariant tokens are NOT redefined per theme", () => {
    const wrongly = [...THEME_INVARIANT].filter((t) => light.has(t));
    expect(wrongly, "declared invariant but redefined in .desk-light").toEqual([]);
  });

  it("no rule outside the two theme blocks hardcodes a colour", () => {
    let rest = CSS.replace(DARK, "").replace(LIGHT, "");
    rest = rest.replace(/\/\*[\s\S]*?\*\//g, "");   // comments may discuss hexes
    const offenders: string[] = [];
    for (const line of rest.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("--")) continue;
      if (hardcodesColour(t)) offenders.push(t.slice(0, 90));
    }
    expect(offenders, "hardcoded colours the light theme cannot re-point").toEqual([]);
  });
});

/* ── the text ramp ───────────────────────────────────────────────────────────
   Light text used to sit BELOW its dark counterpart at every tier, which is
   what "washed out in light mode" actually was, measurably. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("text ramp parity", () => {
  const dark = tokens(DARK);
  const light = tokens(LIGHT);

  for (const tier of ["--text-secondary", "--text-tertiary", "--text-dim"]) {
    it(`${tier} reads as strongly on the light desk as on the dark one`, () => {
      const d = contrast(dark.get(tier)!, dark.get("--panel")!);
      const l = contrast(light.get(tier)!, light.get("--panel")!);
      // Light may be crisper, never weaker. 0.1 absorbs hex rounding.
      expect(l, `dark ${d.toFixed(2)}:1 vs light ${l.toFixed(2)}:1`).toBeGreaterThan(d - 0.1);
    });
  }

  /* WCAG AA, enforced as a FLOOR on both desks.
     `--text-tertiary` and `--text-dim` used to sit at 3.48:1 and 2.42:1 — both
     below AA — in dark AND light. That was invisible while the two themes were
     compared only to each other: matching a ramp says nothing about whether the
     ramp is legible. Tertiary carries content (vendor names, run states,
     timestamps) so it takes the 4.5:1 body floor; dim is de-emphasis only and
     takes 3:1. Anything that carries meaning must not be added below these. */
  for (const [tier, floor] of [
    ["--text-primary", 4.5],
    ["--text-secondary", 4.5],
    ["--text-tertiary", 4.5],
    ["--text-dim", 3.0],
  ] as const) {
    for (const [name, block] of [
      ["dark", DARK],
      ["light", LIGHT],
    ] as const) {
      it(`${tier} clears ${floor}:1 on the ${name} desk`, () => {
        const t = tokens(block);
        const got = contrast(t.get(tier)!, t.get("--panel")!);
        expect(got, `${got.toFixed(2)}:1`).toBeGreaterThanOrEqual(floor - 0.01);
      });
    }
  }

  it("--text-primary is at least as strong on light as on dark", () => {
    const d = contrast(dark.get("--text-primary")!, dark.get("--panel")!);
    const l = contrast(light.get("--text-primary")!, light.get("--panel")!);
    expect(l).toBeGreaterThan(d - 0.1);
  });
});

/* ── the topology, the surface the founder called out ─────────────────────── */
describe("topology figure/ground", () => {
  const dark = tokens(DARK);
  const light = tokens(LIGHT);
  const resolve = (map: Map<string, string>, name: string): string => {
    let v = map.get(name);
    for (let i = 0; i < 6 && v?.startsWith("var("); i += 1) {
      v = map.get(v.slice(4, v.indexOf(")")).trim());
    }
    return v!;
  };

  it("a node card separates from the stage at least as well in light as in dark", () => {
    const d = contrast(resolve(dark, "--topo-node"), resolve(dark, "--topo-ground"));
    const l = contrast(resolve(light, "--topo-node"), resolve(light, "--topo-ground"));
    expect(l, `dark ${d.toFixed(2)}:1 vs light ${l.toFixed(2)}:1`).toBeGreaterThanOrEqual(d);
  });

  it("dispatch edges are at least as visible in light as in dark", () => {
    const d = contrast(resolve(dark, "--topo-line"), resolve(dark, "--topo-ground"));
    const l = contrast(resolve(light, "--topo-line"), resolve(light, "--topo-ground"));
    expect(l, `dark ${d.toFixed(2)}:1 vs light ${l.toFixed(2)}:1`).toBeGreaterThanOrEqual(d);
  });

  it("the node border is at least as visible in light as in dark", () => {
    const d = contrast(resolve(dark, "--topo-node-border"), resolve(dark, "--topo-ground"));
    const l = contrast(resolve(light, "--topo-node-border"), resolve(light, "--topo-ground"));
    expect(l, `dark ${d.toFixed(2)}:1 vs light ${l.toFixed(2)}:1`).toBeGreaterThanOrEqual(d);
  });
});
