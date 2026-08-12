import { describe, expect, it } from "vitest";
import {
  classifyTerminalLink,
  isTerminalLinkActivationClick,
} from "../src/renderer/lib/terminal-link-security.js";

/**
 * ROADMAP T4 — the OSC-8 hyperlink allowlist every terminal pane's link
 * handler consults before a ⌘-click is allowed to go anywhere. A terminal's
 * hyperlinks are an AGENT-CONTROLLED CHANNEL INTO THE UI, so this is the one
 * gate deciding "underline it, but never open it" vs. "safe to open" — the
 * renderer half; `terminal-link-validate.ts` restates the same posture for
 * trusted main, which never trusts this classification alone.
 */
const WORKSPACE = "/Users/founder/muon-labs";

describe("classifyTerminalLink — URLs", () => {
  it("allows http(s) links", () => {
    expect(classifyTerminalLink("https://example.com/path", null)).toEqual({
      kind: "url",
      url: "https://example.com/path",
    });
    expect(classifyTerminalLink("http://example.com", null)).toEqual({
      kind: "url",
      url: "http://example.com/",
    });
  });

  it("denies embedded credentials", () => {
    expect(
      classifyTerminalLink("https://user:pass@example.com", null)
    ).toBeNull();
  });

  it("denies non-http(s) schemes: javascript:, data:, vscode:, ssh:, mailto:", () => {
    for (const uri of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vscode://file/etc/passwd",
      "ssh://host/",
      "mailto:someone@example.com",
    ]) {
      expect(classifyTerminalLink(uri, WORKSPACE)).toBeNull();
    }
  });

  it("denies empty/whitespace-only text", () => {
    expect(classifyTerminalLink("", WORKSPACE)).toBeNull();
    expect(classifyTerminalLink("   ", WORKSPACE)).toBeNull();
  });
});

describe("classifyTerminalLink — in-workspace paths", () => {
  it("allows a plain relative path resolved against the workspace root", () => {
    expect(classifyTerminalLink("src/main.ts", WORKSPACE)).toEqual({
      kind: "path",
      absolutePath: `${WORKSPACE}/src/main.ts`,
    });
  });

  it("allows a plain absolute path already inside the workspace", () => {
    expect(
      classifyTerminalLink(`${WORKSPACE}/apps/desktop/package.json`, WORKSPACE)
    ).toEqual({
      kind: "path",
      absolutePath: `${WORKSPACE}/apps/desktop/package.json`,
    });
  });

  it("allows a localhost file:// URI inside the workspace", () => {
    expect(
      classifyTerminalLink(`file://${WORKSPACE}/README.md`, WORKSPACE)
    ).toEqual({ kind: "path", absolutePath: `${WORKSPACE}/README.md` });
  });

  it("denies a file:// URI with a non-localhost authority", () => {
    expect(
      classifyTerminalLink(`file://remote-host${WORKSPACE}/README.md`, WORKSPACE)
    ).toBeNull();
  });

  it("denies a path that escapes the workspace via ..", () => {
    expect(classifyTerminalLink("../../etc/passwd", WORKSPACE)).toBeNull();
    expect(
      classifyTerminalLink(`${WORKSPACE}/../../etc/passwd`, WORKSPACE)
    ).toBeNull();
  });

  it("denies an absolute path outside the workspace entirely", () => {
    expect(classifyTerminalLink("/etc/passwd", WORKSPACE)).toBeNull();
    expect(classifyTerminalLink("/Users/founder/other-repo", WORKSPACE)).toBeNull();
  });

  it("denies walking above the filesystem root even from a relative start", () => {
    expect(classifyTerminalLink("../../../../../../etc/passwd", WORKSPACE)).toBeNull();
  });

  it("denies every path-shaped link when there is no bound workspace", () => {
    expect(classifyTerminalLink("src/main.ts", null)).toBeNull();
    expect(classifyTerminalLink(`${WORKSPACE}/README.md`, null)).toBeNull();
  });

  it("normalizes '.' segments and duplicate slashes", () => {
    expect(
      classifyTerminalLink(`./src/./main.ts`, WORKSPACE)
    ).toEqual({ kind: "path", absolutePath: `${WORKSPACE}/src/main.ts` });
  });
});

describe("isTerminalLinkActivationClick", () => {
  it("requires ⌘ or Ctrl — a bare click never activates a link", () => {
    expect(
      isTerminalLinkActivationClick({ metaKey: false, ctrlKey: false })
    ).toBe(false);
    expect(
      isTerminalLinkActivationClick({ metaKey: true, ctrlKey: false })
    ).toBe(true);
    expect(
      isTerminalLinkActivationClick({ metaKey: false, ctrlKey: true })
    ).toBe(true);
  });
});
