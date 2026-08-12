import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  MANUAL_FALLBACK,
  confirmBoot,
  performSwap,
  planSwap,
  sha512Base64,
  swapRefusalReason,
  type SwapIo,
} from "../src/lib/staged-swap.js";

// ADR-0029. The swap's promise is narrow and absolute: verified bytes only,
// two renames with rollback, backup survives until a healthy boot. These
// tests pin each clause with injected io; the darwin-only block at the end
// runs the REAL ditto + rename path once (real-library rule: an embedded
// system tool needs one no-mock run).

describe("swapRefusalReason", () => {
  const base = {
    packaged: true,
    platform: "darwin" as NodeJS.Platform,
    appBundlePath: "/Applications/MUON.app",
    // "Checked, none found" — the fields are REQUIRED so a caller cannot
    // skip the ownership check by omission (round-3 #3).
    resolvedElsewhere: null,
    packageManagerReceipt: null,
  };

  it("allows the packaged darwin /Applications install", () => {
    expect(swapRefusalReason(base)).toBeNull();
  });

  it("refuses a package-manager-owned install and names the manager's verb", () => {
    // The Homebrew cask installs to exactly the path the older checks
    // accepted — swapping under the manager corrupts its next upgrade.
    expect(
      swapRefusalReason({
        ...base,
        packageManagerReceipt: "/opt/homebrew/Caskroom/muon",
      })
    ).toMatch(/brew upgrade --cask muon/);
    // The symlink-into-a-store pattern (a manager's `latest` link).
    expect(
      swapRefusalReason({
        ...base,
        resolvedElsewhere: "/opt/store/muon/0.3.0/MUON.app",
      })
    ).toMatch(/package manager owns it/);
  });

  it("refuses dev builds, other platforms, and non-/Applications installs", () => {
    expect(swapRefusalReason({ ...base, packaged: false })).toMatch(/packaged/);
    expect(
      swapRefusalReason({ ...base, platform: "linux" as NodeJS.Platform })
    ).toMatch(/macOS/);
    expect(swapRefusalReason({ ...base, appBundlePath: null })).toContain(
      "getmuon.com/download"
    );
    expect(
      swapRefusalReason({ ...base, appBundlePath: "/Users/x/Desktop/MUON.app" })
    ).toContain("getmuon.com/download");
    // A nested path under /Applications is not the installed bundle.
    expect(
      swapRefusalReason({ ...base, appBundlePath: "/Applications/Sub/MUON.app" })
    ).toContain("getmuon.com/download");
  });
});

describe("planSwap", () => {
  it("parks the old bundle dot-hidden and version-suffixed", () => {
    const plan = planSwap({
      appBundlePath: "/Applications/MUON.app",
      stagingDir: "/data/updates/staged",
      currentVersion: "0.1.0",
      newVersion: "0.1.1",
    });
    expect(plan.backupBundlePath).toBe("/Applications/.MUON.app.backup-0.1.0");
    expect(plan.stagedBundlePath).toBe("/data/updates/staged/MUON.app");
    expect(plan.version).toBe("0.1.1");
  });
});

describe("performSwap", () => {
  const plan = planSwap({
    appBundlePath: "/Applications/MUON.app",
    stagingDir: "/staging",
    currentVersion: "0.1.0",
    newVersion: "0.1.1",
  });

  function fakeIo(present: Set<string>): SwapIo & { renames: [string, string][] } {
    const renames: [string, string][] = [];
    return {
      renames,
      unpackZip: vi.fn(async () => undefined),
      stripQuarantine: vi.fn(async () => undefined),
      exists: (p) => present.has(p),
      rename: async (from, to) => {
        renames.push([from, to]);
        present.delete(from);
        present.add(to);
      },
      removeTree: async (p) => {
        present.delete(p);
      },
    };
  }

  it("swaps via two renames and leaves the new bundle installed", async () => {
    const present = new Set([
      "/Applications/MUON.app",
      "/staging/MUON.app/Contents/MacOS",
    ]);
    const io = fakeIo(present);
    await performSwap(plan, "/zips/u.zip", io);
    expect(io.renames).toEqual([
      ["/Applications/MUON.app", "/Applications/.MUON.app.backup-0.1.0"],
      ["/staging/MUON.app", "/Applications/MUON.app"],
    ]);
    expect(present.has("/Applications/.MUON.app.backup-0.1.0")).toBe(true);
  });

  it("refuses a zip with no app bundle inside, before any rename", async () => {
    const present = new Set(["/Applications/MUON.app"]); // no staged Contents/MacOS
    const io = fakeIo(present);
    await expect(performSwap(plan, "/zips/u.zip", io)).rejects.toThrow(
      MANUAL_FALLBACK.slice(0, 20)
    );
    expect(io.renames).toEqual([]);
    expect(present.has("/Applications/MUON.app")).toBe(true);
  });

  it("rolls the park-rename back when installing the new bundle fails", async () => {
    const present = new Set([
      "/Applications/MUON.app",
      "/staging/MUON.app/Contents/MacOS",
    ]);
    const io = fakeIo(present);
    const realRename = io.rename;
    let calls = 0;
    io.rename = async (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      await realRename(from, to);
    };
    await expect(performSwap(plan, "/zips/u.zip", io)).rejects.toThrow("disk full");
    // The rollback restored the original path.
    expect(present.has("/Applications/MUON.app")).toBe(true);
    expect(present.has("/Applications/.MUON.app.backup-0.1.0")).toBe(false);
  });

  it("a failed rollback names the backup path instead of masking the failure", async () => {
    const present = new Set([
      "/Applications/MUON.app",
      "/staging/MUON.app/Contents/MacOS",
    ]);
    const io = fakeIo(present);
    const realRename = io.rename;
    let calls = 0;
    io.rename = async (from, to) => {
      calls += 1;
      if (calls >= 2) throw new Error("disk full");
      await realRename(from, to);
    };
    await expect(performSwap(plan, "/zips/u.zip", io)).rejects.toThrow(
      /intact at \/Applications\/\.MUON\.app\.backup-0\.1\.0/
    );
  });

  it("clears stale backup residue from an interrupted older update", async () => {
    const present = new Set([
      "/Applications/MUON.app",
      "/Applications/.MUON.app.backup-0.1.0",
      "/staging/MUON.app/Contents/MacOS",
    ]);
    const io = fakeIo(present);
    await performSwap(plan, "/zips/u.zip", io);
    expect(present.has("/Applications/MUON.app")).toBe(true);
  });
});

describe("confirmBoot", () => {
  it("reports the update and drops the rollback copy on first new-version boot", async () => {
    const removed: string[] = [];
    const result = await confirmBoot({
      currentVersion: "0.1.1",
      lastRunVersion: "0.1.0",
      appBundlePath: "/Applications/MUON.app",
      io: {
        exists: (p) => p === "/Applications/.MUON.app.backup-0.1.0",
        removeTree: async (p) => {
          removed.push(p);
        },
      },
    });
    expect(result).toEqual({ justUpdated: true, from: "0.1.0" });
    expect(removed).toEqual(["/Applications/.MUON.app.backup-0.1.0"]);
  });

  it("is a no-op on an ordinary boot and on first-ever boot", async () => {
    const io = { exists: () => true, removeTree: vi.fn(async () => undefined) };
    expect(
      await confirmBoot({
        currentVersion: "0.1.1",
        lastRunVersion: "0.1.1",
        appBundlePath: "/Applications/MUON.app",
        io,
      })
    ).toEqual({ justUpdated: false });
    expect(
      await confirmBoot({
        currentVersion: "0.1.1",
        lastRunVersion: undefined,
        appBundlePath: "/Applications/MUON.app",
        io,
      })
    ).toEqual({ justUpdated: false });
    expect(io.removeTree).not.toHaveBeenCalled();
  });
});

describe("sha512Base64", () => {
  it("matches the electron-builder feed convention (base64, not hex)", () => {
    // Precomputed: `printf muon | shasum -a 512 -b | xxd -r -p | base64`.
    expect(sha512Base64(Buffer.from("muon"))).toBe(
      "cyqZt8fk9bOONxobuFepOnXB2huilQmlkGPkNBuAFKAYbW2yTwx4ry1cGextScURdj+qT4RB06eXibm5c8OI4g=="
    );
  });
});

// ── The one no-mock run: real ditto + real renames in a temp dir ────────────
const darwinIt = process.platform === "darwin" ? it : it.skip;

describe("staged swap against the real macOS toolchain", () => {
  const root = mkdtempSync(path.join(tmpdir(), "muon-swap-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  darwinIt("unpacks with ditto, swaps, and preserves the executable", async () => {
    // Build a fixture "installed app" and a zipped "new version".
    const apps = path.join(root, "Applications");
    const appPath = path.join(apps, "MUON.app");
    mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
    writeFileSync(path.join(appPath, "Contents", "MacOS", "MUON"), "old");

    const newApp = path.join(root, "build", "MUON.app");
    mkdirSync(path.join(newApp, "Contents", "MacOS"), { recursive: true });
    writeFileSync(path.join(newApp, "Contents", "MacOS", "MUON"), "new");
    const zip = path.join(root, "update.zip");
    execFileSync("/usr/bin/ditto", ["-c", "-k", path.join(root, "build"), zip]);

    const { execFile } = await import("node:child_process");
    const fsp = await import("node:fs/promises");
    const stagingDir = path.join(root, "staged");
    const plan = {
      ...planSwap({
        appBundlePath: appPath,
        stagingDir,
        currentVersion: "0.1.0",
        newVersion: "0.1.1",
      }),
    };
    await performSwap(plan, zip, {
      unpackZip: (z, dest) =>
        new Promise((resolve, reject) =>
          execFile("/usr/bin/ditto", ["-x", "-k", z, dest], (e) =>
            e ? reject(e) : resolve()
          )
        ),
      stripQuarantine: async () => undefined,
      exists: (p) => existsSync(p),
      rename: (from, to) => fsp.rename(from, to),
      removeTree: (p) => fsp.rm(p, { recursive: true, force: true }),
    });

    const { readFileSync } = await import("node:fs");
    expect(
      readFileSync(path.join(appPath, "Contents", "MacOS", "MUON"), "utf8")
    ).toBe("new");
    expect(existsSync(path.join(apps, ".MUON.app.backup-0.1.0"))).toBe(true);
  });
});

describe("ditto extraction containment (review finding 8)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "muon-zipslip-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  darwinIt("a ../-escaping zip entry cannot write outside the staging dir", async () => {
    // Build a zip whose entry name traverses upward. `zip` stores the raw
    // name; extraction behaviour is what we are pinning.
    const build = path.join(root, "build");
    mkdirSync(build, { recursive: true });
    writeFileSync(path.join(build, "innocent.txt"), "ok");
    const zip = path.join(root, "evil.zip");
    execFileSync("/usr/bin/zip", ["-q", zip, "innocent.txt"], { cwd: build });
    // Rewrite the stored entry name to a traversal path. The zip format keeps
    // the name in both local + central headers at fixed offsets for a single
    // small entry; patch both occurrences.
    const bytes = readFileSync(zip);
    const patched = Buffer.from(
      bytes.toString("latin1").replaceAll("innocent.txt", "../escaped.txt"),
      "latin1"
    );
    writeFileSync(zip, patched);

    const staging = path.join(root, "staging");
    mkdirSync(staging, { recursive: true });
    try {
      execFileSync("/usr/bin/ditto", ["-x", "-k", zip, staging]);
    } catch {
      // Refusing the archive outright is ALSO containment.
    }
    // The one property that matters: nothing escaped the staging dir.
    expect(existsSync(path.join(root, "escaped.txt"))).toBe(false);
  });
});
