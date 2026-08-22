import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSeedPlan,
  extractAdrSeeds,
  extractPostmortemSeeds,
  extractRuleSeeds,
} from "../src/lib/memory-seed.js";

// ADR-0059 — the extractors are CONSERVATIVE and typed per source kind. What
// these pin: each source maps to exactly its note kind; prose never becomes a
// constraint; every candidate carries its source path as the MODULE ANCHOR
// (so ADR-0058's anchor check covers seeded notes from birth); and a missing
// source is an empty list, never a throw.

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
});

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-seed-"));
  tempRoots.push(dir);
  return dir;
}

describe("extractAdrSeeds", () => {
  it("one decision per ADR: title, status, and its Decides line", () => {
    const repo = tempRepo();
    const adrDir = path.join(repo, "docs", "adr");
    fs.mkdirSync(adrDir, { recursive: true });
    fs.writeFileSync(
      path.join(adrDir, "0001-pick-sqlite.md"),
      [
        "# ADR-0001: Pick SQLite",
        "",
        "- **Status:** Accepted (2026-01-01)",
        "- **Decides:** the embedded store is SQLite, not Postgres.",
        "- **Evidence:** none",
        "",
        "## Context",
      ].join("\n")
    );
    const seeds = extractAdrSeeds(adrDir, path.join("docs", "adr"));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      kind: "decision",
      // REPO-RELATIVE, resolvable from the root — this is the module anchor
      // memory_ground checks, and the first version baked the broken
      // basename form ("adr/…") into this very assertion.
      sourcePath: path.join("docs", "adr", "0001-pick-sqlite.md"),
    });
    expect(seeds[0]!.text).toContain("ADR-0001: Pick SQLite");
    expect(seeds[0]!.text).toContain("[Accepted]");
    expect(seeds[0]!.text).toContain("SQLite, not Postgres");
  });

  it("a missing directory is an empty list, never a throw", () => {
    expect(extractAdrSeeds("/definitely/not/a/dir")).toEqual([]);
  });
});

describe("extractRuleSeeds", () => {
  it("takes rule-heading bullets and bold imperatives; leaves prose alone", () => {
    const repo = tempRepo();
    const file = path.join(repo, "CLAUDE.md");
    fs.writeFileSync(
      file,
      [
        "# Project",
        "",
        "Some prose paragraph that must never become a constraint.",
        "",
        "## Always Do",
        "",
        "- **MUST run impact analysis before editing any symbol.**",
        "- Use the graph before grepping, every time.",
        "",
        "## Background",
        "",
        "- A bullet under a NON-rule heading stays out.",
        "- **NEVER rename symbols with find-and-replace** — bold imperative, in.",
      ].join("\n")
    );
    const seeds = extractRuleSeeds(file, "CLAUDE.md");
    expect(seeds).toHaveLength(3);
    expect(seeds.every((seed) => seed.kind === "constraint")).toBe(true);
    expect(seeds.every((seed) => seed.sourcePath === "CLAUDE.md")).toBe(true);
    const texts = seeds.map((seed) => seed.text).join("\n");
    expect(texts).toContain("MUST run impact analysis");
    expect(texts).toContain("NEVER rename symbols");
    expect(texts).not.toContain("prose paragraph");
    expect(texts).not.toContain("NON-rule heading");
  });
});

describe("extractPostmortemSeeds", () => {
  it("one lesson per file in a recognizable directory", () => {
    const repo = tempRepo();
    const dir = path.join(repo, "docs", "postmortems");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "2026-03-backfill.md"),
      "# The March backfill double-counted events\n\nBody.\n"
    );
    const seeds = extractPostmortemSeeds(repo);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ kind: "attempt" });
    expect(seeds[0]!.text).toContain("March backfill double-counted");
    expect(seeds[0]!.sourcePath).toBe(
      path.join("docs", "postmortems", "2026-03-backfill.md")
    );
  });

  it("no recognizable directory is an empty list", () => {
    expect(extractPostmortemSeeds(tempRepo())).toEqual([]);
  });
});

describe("buildSeedPlan against THIS repository", () => {
  it("finds this repo's own ADRs and rules — the live cold-start it exists for", () => {
    // The one fixture that cannot drift from reality: MUON's own tree. If this
    // ever reads zero, the extractors broke against exactly the corpus the
    // founder will run them on first.
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
    const plan = buildSeedPlan(repoRoot);
    expect(plan.decisions.length).toBeGreaterThan(50); // ADR-0001 … 0059+
    expect(plan.constraints.length).toBeGreaterThan(3); // CLAUDE.md's Always/Never
    for (const seed of [...plan.decisions, ...plan.constraints]) {
      expect(seed.text.length).toBeLessThanOrEqual(480);
      // Every anchor must resolve FROM THE REPO ROOT — the property the
      // review found broken: birth-time grounding is only real if the
      // recorded path exists.
      expect(
        fs.existsSync(path.join(repoRoot, seed.sourcePath)),
        seed.sourcePath
      ).toBe(true);
    }
  });
});
