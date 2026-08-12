import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderKeymapMarkdown } from "../src/lib/keymap.js";

// ADR-0032 D6 — the README's key table is GENERATED from the keymap, so it
// cannot quietly fall behind. The inventory found the old hand-written table
// documenting 8 of ~28 bindings and wrong about which context they applied in;
// this test is what makes that unable to happen again.
//
// When this fails, regenerate rather than editing the README by hand.

const README = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "README.md"
);

describe("README key table", () => {
  it("matches the generated table exactly", () => {
    const readme = readFileSync(README, "utf8");
    const generated = renderKeymapMarkdown();
    expect(
      readme.includes(generated),
      "apps/tui/README.md's Keys section has drifted from src/lib/keymap.ts — regenerate it"
    ).toBe(true);
  });

  it("marks the section as generated so nobody edits it by hand", () => {
    const readme = readFileSync(README, "utf8");
    expect(readme).toContain("Generated from src/lib/keymap.ts");
  });
});
