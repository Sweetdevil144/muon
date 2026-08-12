import { describe, expect, it } from "vitest";
import { withDefaultPaths } from "../src/lib/path-fix.js";

// The Finder-launch PATH repair. Small, but it is the difference between the
// vendor tab bar working from a dock launch and every spawn dying with
// "not on the PATH this app was launched with".

describe("withDefaultPaths", () => {
  it("prepends the vendor install locations ahead of the system dirs", () => {
    const merged = withDefaultPaths("/usr/bin:/bin", "/Users/dev").split(":");
    for (const dir of [
      "/opt/homebrew/bin",
      "/Users/dev/.local/bin",
      "/Users/dev/.local/share/mise/shims",
      // opencode's installer writes ONLY a shell-profile PATH entry, which a
      // Finder launch never sources.
      "/Users/dev/.opencode/bin",
    ]) {
      expect(merged).toContain(dir);
      expect(merged.indexOf(dir)).toBeLessThan(merged.indexOf("/usr/bin"));
    }
  });

  it("deduplicates while preserving the existing PATH entries", () => {
    const merged = withDefaultPaths(
      "/opt/homebrew/bin:/Users/dev/custom",
      "/Users/dev"
    );
    expect(merged.split(":").filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
    expect(merged.split(":")).toContain("/Users/dev/custom");
  });
});
