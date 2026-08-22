/**
 * The gh-style device-code moment (founder request, 2026-08-19): the code goes
 * onto the clipboard, Enter opens the browser. The invariant that matters most
 * is the downgrade one: no clipboard, no browser, no TTY — the sign-in still
 * proceeds with the code and URL printed, exactly the old behavior. A
 * convenience refused must never block a flow that works.
 */
import { describe, expect, it, vi } from "vitest";
import {
  clipboardCandidates,
  copyToClipboard,
  openInBrowser,
  presentDeviceCode,
} from "../src/lib/device-code-prompt.js";

const FLOW = {
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
  expiresAt: "2026-08-19T12:15:00.000Z",
};

describe("clipboardCandidates", () => {
  it("names one writer per platform where there is one", () => {
    expect(clipboardCandidates("darwin")).toEqual([
      { command: "pbcopy", args: [] },
    ]);
    expect(clipboardCandidates("win32")).toEqual([
      { command: "clip", args: [] },
    ]);
  });

  it("tries all three Linux ecosystems in order — Wayland before X11", () => {
    expect(clipboardCandidates("linux").map((c) => c.command)).toEqual([
      "wl-copy",
      "xclip",
      "xsel",
    ]);
  });
});

describe("copyToClipboard", () => {
  it("stops at the first writer that accepts", async () => {
    const tryWrite = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    expect(await copyToClipboard("code", "linux", tryWrite)).toBe(true);
    expect(tryWrite).toHaveBeenCalledTimes(2);
  });

  it("reports false when every writer refuses — never throws", async () => {
    const tryWrite = vi.fn().mockResolvedValue(false);
    expect(await copyToClipboard("code", "linux", tryWrite)).toBe(false);
  });

  it("never writes an empty code", async () => {
    const tryWrite = vi.fn();
    expect(await copyToClipboard("", "darwin", tryWrite)).toBe(false);
    expect(tryWrite).not.toHaveBeenCalled();
  });
});

describe("openInBrowser", () => {
  it("refuses a non-https url without spawning", async () => {
    expect(await openInBrowser("file:///etc/passwd")).toBe(false);
    expect(await openInBrowser("javascript:alert(1)")).toBe(false);
  });
});

describe("presentDeviceCode", () => {
  it("TTY: copies, waits for Enter, opens the browser", async () => {
    const lines: string[] = [];
    const open = vi.fn().mockResolvedValue(true);
    const waitEnter = vi.fn().mockResolvedValue(true);
    await presentDeviceCode(FLOW, {
      write: (l) => lines.push(l),
      isTTY: true,
      copy: vi.fn().mockResolvedValue(true),
      open,
      waitEnter,
    });
    const output = lines.join("");
    expect(output).toContain("ABCD-EFGH is on your clipboard");
    expect(output).toContain("Press Enter to open https://github.com/login/device");
    expect(waitEnter).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("https://github.com/login/device");
    expect(output).toContain("Waiting for authorization");
  });

  it("TTY with a refusing clipboard: the code is still printed and the flow proceeds", async () => {
    const lines: string[] = [];
    await presentDeviceCode(FLOW, {
      write: (l) => lines.push(l),
      isTTY: true,
      copy: vi.fn().mockResolvedValue(false),
      open: vi.fn().mockResolvedValue(true),
      waitEnter: vi.fn().mockResolvedValue(true),
    });
    const output = lines.join("");
    expect(output).toContain("ABCD-EFGH");
    expect(output).not.toContain("on your clipboard");
  });

  it("TTY with no browser: says where to go instead of failing", async () => {
    const lines: string[] = [];
    await presentDeviceCode(FLOW, {
      write: (l) => lines.push(l),
      isTTY: true,
      copy: vi.fn().mockResolvedValue(true),
      open: vi.fn().mockResolvedValue(false),
      waitEnter: vi.fn().mockResolvedValue(true),
    });
    expect(lines.join("")).toContain(
      "visit https://github.com/login/device yourself"
    );
  });

  it("TTY nobody is watching: the Enter timeout continues WITHOUT opening a browser", async () => {
    const lines: string[] = [];
    const open = vi.fn();
    await presentDeviceCode(FLOW, {
      write: (l) => lines.push(l),
      isTTY: true,
      copy: vi.fn().mockResolvedValue(true),
      open,
      waitEnter: vi.fn().mockResolvedValue(false), // timed out
    });
    const output = lines.join("");
    // The sign-in proceeds — polling starts — but no browser is opened into a
    // session nobody is watching.
    expect(open).not.toHaveBeenCalled();
    expect(output).toContain("No keypress");
    expect(output).toContain("https://github.com/login/device");
    expect(output).toContain("Waiting for authorization");
  });

  it("non-TTY: prints code + URL and NEVER waits on stdin", async () => {
    const lines: string[] = [];
    const waitEnter = vi.fn();
    const open = vi.fn();
    await presentDeviceCode(FLOW, {
      write: (l) => lines.push(l),
      isTTY: false,
      copy: vi.fn().mockResolvedValue(false),
      open,
      waitEnter,
    });
    const output = lines.join("");
    expect(output).toContain("ABCD-EFGH");
    expect(output).toContain("https://github.com/login/device");
    expect(output).toContain("Waiting for authorization");
    expect(waitEnter).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
