import { describe, expect, it } from "vitest";
import {
  isAllowedTerminalLinkUrl,
  isWithinWorkspaceRoot,
} from "../src/lib/terminal-link-validate.js";

/**
 * ROADMAP T4 — trusted MAIN's own, independent re-check of an OSC-8 hyperlink
 * target before `muon:openTerminalLink` touches `shell.openExternal` or
 * reveals a path in Finder. The renderer's own classification
 * (`terminal-link-security.test.ts`) is never trusted alone; this is the
 * gate that actually matters.
 */
describe("isAllowedTerminalLinkUrl", () => {
  it("allows http(s)", () => {
    expect(isAllowedTerminalLinkUrl("https://example.com")).toBe(true);
    expect(isAllowedTerminalLinkUrl("http://example.com/path?q=1")).toBe(true);
  });

  it("denies non-http(s) schemes", () => {
    expect(isAllowedTerminalLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedTerminalLinkUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedTerminalLinkUrl("vscode://file/etc/passwd")).toBe(false);
  });

  it("denies embedded credentials", () => {
    expect(isAllowedTerminalLinkUrl("https://user:pass@example.com")).toBe(
      false
    );
  });

  it("denies unparseable strings rather than throwing", () => {
    expect(isAllowedTerminalLinkUrl("not a url at all")).toBe(false);
  });
});

describe("isWithinWorkspaceRoot", () => {
  const root = "/Users/founder/muon-labs";

  it("allows the root itself and any path nested under it", () => {
    expect(isWithinWorkspaceRoot(root, root)).toBe(true);
    expect(isWithinWorkspaceRoot(`${root}/apps/desktop`, root)).toBe(true);
  });

  it("denies a path outside the root, including a name-prefix lookalike", () => {
    expect(isWithinWorkspaceRoot("/Users/founder/other", root)).toBe(false);
    // `/Users/founder/muon-labs-evil` textually starts with `root` but is a
    // SIBLING directory, not a child — the `path.sep` boundary check matters.
    expect(isWithinWorkspaceRoot(`${root}-evil`, root)).toBe(false);
  });

  it("denies a path that escapes the root via ..", () => {
    expect(isWithinWorkspaceRoot(`${root}/../../etc/passwd`, root)).toBe(false);
  });

  it("denies non-absolute candidates or roots", () => {
    expect(isWithinWorkspaceRoot("relative/path", root)).toBe(false);
    expect(isWithinWorkspaceRoot(`${root}/file`, "relative-root")).toBe(false);
  });
});
