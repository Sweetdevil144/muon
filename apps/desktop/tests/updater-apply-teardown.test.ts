import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Review finding 1 regression pin. The staged-swap apply MUST leave through
// app.quit() — app.exit() skips before-quit, where the quit coordinator
// drains the runner, stops the spawned brain, and reaps pty children.
// Exiting there orphaned the old brain and the relaunched app then adopted
// it via the lockfile: new app code over stale backend code, right after an
// update. A source-level pin (the apply hook lives in main.ts's electron
// wiring, out of unit-test reach) — same idiom as the visual-system CSS
// guards.
// Comments describe the rule; only CODE can violate it. Strip line comments
// before matching so the explanation of the invariant cannot trip its guard.
const main = readFileSync("src/main.ts", "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

describe("staged-swap apply teardown (ADR-0029 / review finding 1)", () => {
  it("relaunches through app.quit(), never app.exit()", () => {
    const applyStart = main.indexOf("async apply(zipPath, version)");
    expect(applyStart).toBeGreaterThan(0);
    // The whole hook body, bounded by the next top-level declaration.
    const applyEnd = main.indexOf("\n}", applyStart);
    const applyBody = main.slice(applyStart, applyEnd);
    expect(applyBody).toContain("app.relaunch()");
    expect(applyBody).toContain("app.quit()");
    expect(applyBody).not.toContain("app.exit(");
  });

  it("nothing else in main reintroduces app.exit()", () => {
    // exit() elsewhere would bypass the same teardown for that path too.
    expect(main.includes("app.exit(")).toBe(false);
  });
});
