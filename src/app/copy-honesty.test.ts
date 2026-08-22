import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The 2026-08-23 marketing appendix's honesty suite. The site is the first
 * thing a buyer or a GitHub visitor reads, and the controlling texts are
 * PolyForm Noncommercial 1.0.0 plus the Individual Use Grant — so the copy
 * is TESTED against the claims it is allowed to make:
 *
 *  1. "open source" never stands alone as a licence claim — any use must
 *     sit beside the licence it actually means (PolyForm / the Grant).
 *  2. /pricing names the commercial object: Linked Operation.
 *  3. /pricing publishes NO price number (combined verdict O6 is open).
 *  4. The forbidden-register words never ship on any page.
 */

const MARKETING_ROOTS = [
  join(__dirname),
  join(__dirname, "..", "components", "muon"),
];

function marketingFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(tsx|ts)$/.test(name)) continue;
      if (/\.test\.tsx?$/.test(name)) continue;
      out.push(path);
    }
  };
  for (const root of MARKETING_ROOTS) walk(root);
  return out;
}

describe("licence honesty (appendix §2 + §7.2)", () => {
  it('never claims "open source" without naming PolyForm or the Individual Use Grant beside it', () => {
    const offenders: string[] = [];
    for (const file of marketingFiles()) {
      const text = readFileSync(file, "utf8");
      const pattern = /open[- ]source/gi;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const window = text.slice(
          Math.max(0, match.index - 300),
          match.index + 300
        );
        if (
          !/PolyForm/i.test(window) &&
          !/Individual Use Grant/i.test(window) &&
          // "not open source in the OSI sense" style honesty is allowed.
          !/OSI/.test(window) &&
          // A statement about the THIRD-PARTY packages MUON is built on
          // ("open-source components", "built on open-source software") is a
          // fact about dependencies, not a licence claim about MUON itself.
          !/open[- ]source (components?|software|packages?)/i.test(window)
        ) {
          offenders.push(`${file} @${match.index}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("/pricing names Linked Operation — the thing Teams actually buys", () => {
    const pricing = readFileSync(
      join(__dirname, "pricing", "page.tsx"),
      "utf8"
    );
    expect(pricing).toContain("Linked Operation");
  });

  it("/pricing publishes no price number (the pricing conversation is open)", () => {
    const pricing = readFileSync(
      join(__dirname, "pricing", "page.tsx"),
      "utf8"
    );
    for (const forbidden of ["₹", "$19", "$29", "$49", "1,499"]) {
      expect(pricing).not.toContain(forbidden);
    }
  });

  it("the forbidden register never ships", () => {
    const offenders: string[] = [];
    for (const file of marketingFiles()) {
      const text = readFileSync(file, "utf8");
      for (const forbidden of [
        "AI-powered",
        "Jira for AI",
        "next-gen",
        "supercharge",
        "Supercharge",
        "best-in-class",
        "game-changer",
      ]) {
        if (text.includes(forbidden)) {
          offenders.push(`${file}: ${forbidden}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
