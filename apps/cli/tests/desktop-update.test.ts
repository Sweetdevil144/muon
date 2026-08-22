/**
 * `muon update`'s desktop half (founder requirement, 2026-08-19: one update
 * updates everything). The invariants that matter:
 *
 *  - the feed's sha512 is verified BEFORE anything is touched (ADR-0029's rule
 *    held from the outside), and a mismatch installs nothing;
 *  - a RUNNING app is refused, never replaced under a live process;
 *  - every failure is an outcome with a reason, never a throw — the CLI half
 *    of the command may already have succeeded.
 */
import { describe, expect, it, vi } from "vitest";
import {
  describeDesktopOutcome,
  desktopAppCandidatePaths,
  desktopFeedUrl,
  desktopUpdateVerdict,
  parseDesktopFeed,
  updateDesktopApp,
  type DesktopUpdateIo,
} from "../src/lib/desktop-update.js";

const FEED = [
  "version: 0.4.8",
  "files:",
  "  - url: MUON-0.4.8-arm64-mac.zip",
  "    sha512: filehash==",
  "    size: 123",
  "  - url: MUON-0.4.8-arm64.dmg",
  "    sha512: dmghash==",
  "path: MUON-0.4.8-arm64-mac.zip",
  "sha512: tophash==",
  "releaseDate: '2026-08-19T00:00:00.000Z'",
].join("\n");

function fakeIo(overrides: Partial<DesktopUpdateIo> = {}): DesktopUpdateIo {
  return {
    findApp: vi
      .fn()
      .mockResolvedValue({ appPath: "/Applications/MUON.app", version: "0.4.7" }),
    fetchFeed: vi.fn().mockResolvedValue(FEED),
    download: vi.fn().mockResolvedValue({
      file: "/tmp/stage-ok/MUON-update.zip",
      sha512: "tophash==",
      staging: "/tmp/stage-ok",
    }),
    isAppRunning: vi.fn().mockResolvedValue(false),
    extract: vi.fn().mockResolvedValue("/tmp/extracted/MUON.app"),
    swap: vi.fn().mockResolvedValue(undefined),
    removeStaging: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("parseDesktopFeed", () => {
  it("reads version, path and the TOP-LEVEL sha512", () => {
    expect(parseDesktopFeed(FEED)).toEqual({
      version: "0.4.8",
      zipPath: "MUON-0.4.8-arm64-mac.zip",
      sha512: "tophash==",
    });
  });

  it("never mistakes an indented per-file sha512 for the artifact's", () => {
    const noTop = FEED.split("\n")
      .filter((l) => l !== "sha512: tophash==")
      .join("\n");
    expect(parseDesktopFeed(noTop)).toBeNull();
  });

  it("refuses a feed whose path is not a zip", () => {
    expect(
      parseDesktopFeed(FEED.replace(/^path: .*$/m, "path: MUON-0.4.8-arm64.dmg"))
    ).toBeNull();
  });
});

describe("desktopAppCandidatePaths", () => {
  it("honors MUON_APP_PATH first, then the two conventional locations", () => {
    expect(
      desktopAppCandidatePaths({ MUON_APP_PATH: "/opt/MUON.app" }, "/Users/op")
    ).toEqual([
      "/opt/MUON.app",
      "/Applications/MUON.app",
      "/Users/op/Applications/MUON.app",
    ]);
  });
});

describe("updateDesktopApp", () => {
  it("updates through download → verify → extract → swap", async () => {
    const io = fakeIo();
    const outcome = await updateDesktopApp("https://download.getmuon.com", io);
    expect(outcome).toEqual({
      kind: "updated",
      from: "0.4.7",
      to: "0.4.8",
      appPath: "/Applications/MUON.app",
    });
    expect(io.download).toHaveBeenCalledWith(
      "https://download.getmuon.com/MUON-0.4.8-arm64-mac.zip"
    );
    expect(io.swap).toHaveBeenCalledWith(
      "/Applications/MUON.app",
      "/tmp/extracted/MUON.app"
    );
  });

  it("a sha512 mismatch installs NOTHING and names both digests", async () => {
    const io = fakeIo({
      download: vi.fn().mockResolvedValue({
        file: "/tmp/stage-x/x.zip",
        sha512: "corrupted==",
        staging: "/tmp/stage-x",
      }),
    });
    const outcome = await updateDesktopApp("https://download.getmuon.com", io);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.reason).toContain("tophash==");
      expect(outcome.reason).toContain("corrupted==");
      expect(outcome.reason).toContain("Nothing was installed");
    }
    expect(io.extract).not.toHaveBeenCalled();
    expect(io.swap).not.toHaveBeenCalled();
  });

  it("refuses to replace a RUNNING app, without downloading", async () => {
    const io = fakeIo({ isAppRunning: vi.fn().mockResolvedValue(true) });
    const outcome = await updateDesktopApp("https://download.getmuon.com", io);
    expect(outcome).toEqual({
      kind: "running",
      installed: "0.4.7",
      latest: "0.4.8",
    });
    expect(io.download).not.toHaveBeenCalled();
    // The refusal copy carries the remedy.
    expect(describeDesktopOutcome(outcome)).toContain("Quit MUON");
  });

  it("skips a machine with no app installed", async () => {
    const io = fakeIo({ findApp: vi.fn().mockResolvedValue(null) });
    expect(await updateDesktopApp("https://x", io)).toEqual({
      kind: "not-installed",
    });
    expect(io.fetchFeed).not.toHaveBeenCalled();
  });

  it("reports current and ahead without touching the disk", async () => {
    const currentIo = fakeIo({
      findApp: vi
        .fn()
        .mockResolvedValue({ appPath: "/Applications/MUON.app", version: "0.4.8" }),
    });
    expect(await updateDesktopApp("https://x", currentIo)).toEqual({
      kind: "current",
      version: "0.4.8",
    });
    const aheadIo = fakeIo({
      findApp: vi
        .fn()
        .mockResolvedValue({ appPath: "/Applications/MUON.app", version: "0.5.0" }),
    });
    expect(await updateDesktopApp("https://x", aheadIo)).toEqual({
      kind: "ahead",
      installed: "0.5.0",
      latest: "0.4.8",
    });
    expect(currentIo.download).not.toHaveBeenCalled();
    expect(aheadIo.download).not.toHaveBeenCalled();
  });

  it("NEVER throws — an unreadable feed is an outcome with a reason", async () => {
    const io = fakeIo({
      fetchFeed: vi.fn().mockRejectedValue(new Error("HTTP 503")),
    });
    const outcome = await updateDesktopApp("https://x", io);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.reason).toContain("HTTP 503");
  });
});

describe("updateDesktopApp — post-cubic invariants", () => {
  it("re-checks for a RUNNING app after the download, immediately before the swap", async () => {
    // Not running when the download starts, running by the time it finishes —
    // the multi-minute download is exactly when someone launches the app.
    const isAppRunning = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const io = fakeIo({ isAppRunning });
    const outcome = await updateDesktopApp("https://download.getmuon.com", io);
    expect(outcome.kind).toBe("running");
    expect(io.swap).not.toHaveBeenCalled();
  });

  it("removes the staging tree the download NAMED, on success and on a sha512 mismatch", async () => {
    const okIo = fakeIo();
    await updateDesktopApp("https://download.getmuon.com", okIo);
    // The delete keys on the dir `download` said it created — never a path
    // derived from the file (cubic pass-2 #5).
    expect(okIo.removeStaging).toHaveBeenCalledWith("/tmp/stage-ok");

    const badIo = fakeIo({
      download: vi.fn().mockResolvedValue({
        file: "/tmp/stage-bad/x.zip",
        sha512: "corrupted==",
        staging: "/tmp/stage-bad",
      }),
    });
    await updateDesktopApp("https://download.getmuon.com", badIo);
    expect(badIo.removeStaging).toHaveBeenCalledWith("/tmp/stage-bad");
  });

  it("refuses a non-https host before touching anything", async () => {
    const io = fakeIo();
    const outcome = await updateDesktopApp("http://download.getmuon.com", io);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.reason).toContain("https");
    expect(io.findApp).not.toHaveBeenCalled();

    const check = await desktopUpdateVerdict("http://x", fakeIo());
    expect(check.kind).toBe("feed-unreadable");
  });

  it("a non-semver installed version is a legible failure, not a throw", async () => {
    const io = fakeIo({
      findApp: vi
        .fn()
        .mockResolvedValue({ appPath: "/Applications/MUON.app", version: "dev" }),
    });
    const outcome = await updateDesktopApp("https://x.example", io);
    expect(outcome.kind).toBe("failed");
    const check = await desktopUpdateVerdict("https://x.example", io);
    // Its own kind: the feed parsed fine, a VERSION is the problem.
    expect(check.kind).toBe("uncomparable");
  });
});

describe("desktopUpdateVerdict (--check half)", () => {
  it("answers with a verdict for an installed app", async () => {
    const result = await desktopUpdateVerdict(
      "https://download.getmuon.com",
      fakeIo()
    );
    expect(result).toEqual({
      kind: "verdict",
      verdict: { kind: "available", installed: "0.4.7", latest: "0.4.8" },
      appPath: "/Applications/MUON.app",
    });
  });

  it("reads the feed from the SAME url the in-app updater uses", () => {
    expect(desktopFeedUrl("https://download.getmuon.com/")).toBe(
      "https://download.getmuon.com/latest-mac.yml"
    );
  });
});
