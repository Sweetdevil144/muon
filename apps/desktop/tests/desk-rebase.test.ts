import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The founder's 2026-08-11 failure, pinned at the source level: the desktop
 * chased a dead :55666 for six runner-recovery rounds while a live brain sat
 * on another port. The client-level rebase (MuonApiClient's 5th argument) is
 * behaviour-tested in packages/client/tests/api-client-rebase.test.ts; what
 * the DESKTOP owes on top is wiring — makeClient must pass a lockfile
 * resolver, and an explicit operator-entered base must stand it down.
 *
 * Source-shape assertions, deliberately: main.ts is an Electron entry that
 * cannot be imported under vitest without the full app scaffold, and a wiring
 * regression here (dropping the 5th argument again) is exactly a one-line
 * diff a reviewer misses.
 */
describe("desktop main wires the lockfile rebase", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "src", "main.ts"),
    "utf8"
  );

  it("makeClient passes the rebase resolver", () => {
    const site = source.slice(
      source.indexOf("function makeClient"),
      source.indexOf("function makeClient") + 400
    );
    expect(site).toContain("rebaseFromLockfile");
  });

  it("an explicit operator base stands the rebase down", () => {
    expect(source).toMatch(/if \(apiBaseExplicit \|\| !brainDataDir\) return null;/);
    expect(source).toMatch(/apiBaseExplicit = true;/);
  });

  it("a real move resyncs the whole desk, not only the one client", () => {
    const resolver = source.slice(
      source.indexOf("function rebaseFromLockfile"),
      source.indexOf("function makeClient")
    );
    expect(resolver).toContain("applyBrainCoords");
  });
});
