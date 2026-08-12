import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { toWorkspaceRelativePosix } from "../src/paths.js";

// THE canonicalizer, the #1 correctness surface. It must emit exactly the
// workspace-relative POSIX anchor namespace, and SELF-GUARD (F-6) against any
// non-canonical (escaping / absolute) result.

describe("toWorkspaceRelativePosix", () => {
  const root = join(sep, "ws");

  it("maps an in-root file to a workspace-relative POSIX path (no ./ , no /)", () => {
    expect(toWorkspaceRelativePosix(root, join(root, "backend", "src", "a.ts"))).toBe(
      "backend/src/a.ts"
    );
  });

  it("F-6: returns null when the file ESCAPES the root (would be `../…`)", () => {
    expect(toWorkspaceRelativePosix(join(root, "backend"), join(root, "src", "a.ts"))).toBeNull();
  });

  it("F-6: returns null for the root itself (empty relative)", () => {
    expect(toWorkspaceRelativePosix(root, root)).toBeNull();
  });

  it("F-6: returns null for an unrelated absolute path", () => {
    expect(toWorkspaceRelativePosix(root, join(sep, "other", "x.ts"))).toBeNull();
  });
});
