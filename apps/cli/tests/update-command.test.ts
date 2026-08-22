/**
 * `muon update`'s command-level branching (cubic pass-2 #9: it was untested).
 * The failure mode every branch guards is the same one: a no-op or a refusal
 * that LOOKS like a successful update.
 */
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerUpdateCommand } from "../src/commands/update.js";
import type { DesktopUpdateIo } from "../src/lib/desktop-update.js";

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  process.exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function fakeIo(overrides: Partial<DesktopUpdateIo> = {}): DesktopUpdateIo {
  return {
    findApp: vi
      .fn()
      .mockResolvedValue({ appPath: "/Applications/MUON.app", version: "0.4.7" }),
    fetchFeed: vi
      .fn()
      .mockResolvedValue(
        "version: 0.4.8\npath: MUON-0.4.8-arm64-mac.zip\nsha512: h==\n"
      ),
    download: vi.fn(),
    isAppRunning: vi.fn().mockResolvedValue(false),
    extract: vi.fn(),
    swap: vi.fn(),
    removeStaging: vi.fn(),
    ...overrides,
  };
}

function program(io?: DesktopUpdateIo): Command {
  const root = new Command();
  root.name("muon");
  root.exitOverride();
  registerUpdateCommand(root, io);
  return root;
}

async function run(args: string[], io?: DesktopUpdateIo): Promise<void> {
  await program(io).parseAsync(["node", "muon", "update", ...args]);
}

/** Run `fn` with process.platform stubbed — the darwin-only branches must be
 *  REAL on CI (ubuntu), not early-returned no-ops (cubic pass-3 #3). */
async function onPlatform(platform: string, fn: () => Promise<void>): Promise<void> {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}

describe("muon update — command-level branching", () => {
  it("refuses --cli-only with --desktop-only instead of silently selecting nothing", async () => {
    await run(["--cli-only", "--desktop-only"]);
    expect(stderr.join("")).toContain("exclude each other");
    expect(process.exitCode).toBe(1);
  });

  it("says --desktop-only is a macOS-only ask on other platforms, exit 0", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const io = fakeIo();
      await run(["--desktop-only"], io);
      expect(stdout.join("")).toContain("macOS only");
      expect(io.findApp).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("refuses a plaintext host for the WHOLE command — npm install executes lifecycle scripts", async () => {
    const io = fakeIo();
    await run(["--host", "http://evil.example", "--check"], io);
    expect(stderr.join("")).toContain("not https");
    expect(process.exitCode).toBe(1);
    // Nothing was fetched from it, in either half.
    expect(io.fetchFeed).not.toHaveBeenCalled();
    expect(io.findApp).not.toHaveBeenCalled();
  });

  it("--desktop-only --check reports the desktop verdict through the injected io", async () => {
    await onPlatform("darwin", async () => {
      const io = fakeIo();
      await run(["--desktop-only", "--check", "--host", "https://download.getmuon.com"], io);
      const out = stdout.join("");
      expect(out).toContain("desktop app:");
      expect(out).toContain("0.4.8");
      // --check with an available desktop update carries exit 10.
      expect(process.exitCode).toBe(10);
    });
  });

  it("an uncomparable installed version is named as such on --check, exit 1", async () => {
    await onPlatform("darwin", async () => {
      const io = fakeIo({
        findApp: vi
          .fn()
          .mockResolvedValue({ appPath: "/Applications/MUON.app", version: "dev" }),
      });
      await run(["--desktop-only", "--check", "--host", "https://download.getmuon.com"], io);
      expect(stdout.join("")).toContain("version not comparable");
      expect(process.exitCode).toBe(1);
    });
  });

  it("the anomaly exit survives a pending CLI update on a combined --check", async () => {
    await onPlatform("darwin", async () => {
      // CLI half: an update IS available (stub the two host reads).
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 })
        );
      try {
        const io = fakeIo({
          fetchFeed: vi.fn().mockRejectedValue(new Error("HTTP 503")),
        });
        await run(["--check", "--host", "https://download.getmuon.com"], io);
        const out = stdout.join("");
        expect(out).toContain("available");
        expect(out).toContain("could not read the release feed");
        // 1, not 10: the unattended consumer is pulled to the broken half;
        // the pending update reports 10 again once the feed answers.
        expect(process.exitCode).toBe(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("an unreadable desktop feed on --check exits 1, matching the CLI half", async () => {
    await onPlatform("darwin", async () => {
      const io = fakeIo({
        fetchFeed: vi.fn().mockRejectedValue(new Error("HTTP 503")),
      });
      await run(["--desktop-only", "--check", "--host", "https://download.getmuon.com"], io);
      expect(stdout.join("")).toContain("could not read the release feed");
      expect(process.exitCode).toBe(1);
    });
  });
});
