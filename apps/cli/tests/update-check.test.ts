import { describe, expect, it } from "vitest";
import {
  compareSemver,
  decideUpdate,
  describeVerdict,
  installArgv,
  latestTarballUrl,
  parseSemver,
} from "../src/lib/update-check.js";

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("0.2.1", "0.3.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareSemver("0.2.1", "0.2.1")).toBe(0);
    expect(compareSemver("0.2.10", "0.2.9")).toBeGreaterThan(0);
  });

  it("sorts a PRERELEASE BEFORE its final release", () => {
    // The rule string comparison gets wrong: "1.0.0-rc.1" > "1.0.0" as strings,
    // which would offer an rc as an update to the release that superseded it.
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.2")).toBeLessThan(0);
  });

  it("REFUSES an unparseable version rather than ordering it", () => {
    expect(() => compareSemver("latest", "1.0.0")).toThrow(/not a semver/);
    expect(() => compareSemver("1.0", "1.0.0")).toThrow(/not a semver/);
    expect(parseSemver("v1.0.0")).toBeNull();
  });
});

describe("decideUpdate", () => {
  it("offers an update only when the published one is NEWER", () => {
    expect(decideUpdate("0.2.1", "0.3.0")).toEqual({
      kind: "available",
      installed: "0.2.1",
      latest: "0.3.0",
    });
    expect(decideUpdate("0.3.0", "0.3.0").kind).toBe("current");
  });

  it("says AHEAD rather than current for a local build", () => {
    // Folding this into "current" would hide a build that never shipped.
    const verdict = decideUpdate("0.4.0", "0.3.0");
    expect(verdict.kind).toBe("ahead");
    expect(describeVerdict(verdict)).toMatch(/NEWER than the latest release/);
  });

  it("every verdict has a sentence, and it names the versions", () => {
    for (const [a, b] of [["0.2.1", "0.3.0"], ["0.3.0", "0.3.0"], ["0.4.0", "0.3.0"]]) {
      const text = describeVerdict(decideUpdate(a, b));
      expect(text.length, `${a}->${b}`).toBeGreaterThan(10);
      expect(text, `${a}->${b}`).toContain(a);
    }
  });
});

describe("what it will actually run", () => {
  it("installs the stable alias, not a pinned version", () => {
    // A pinned URL would make `muon update` install whatever was current when
    // the binary was BUILT — the one thing an update must never do.
    expect(installArgv()).toEqual([
      "install",
      "-g",
      "https://download.getmuon.com/muon-cli-latest.tgz",
    ]);
  });

  it("honours a custom host without doubling the slash", () => {
    expect(latestTarballUrl("https://example.test/")).toBe(
      "https://example.test/muon-cli-latest.tgz"
    );
    expect(installArgv("https://example.test").at(-1)).toContain("example.test");
  });
});
