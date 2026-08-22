/**
 * Where an INSTALLED machine keeps its gitnexus — the shared base list both
 * the CLI's and the desktop's resolvers probe (founder bug, 2026-08-19: no
 * installed channel could resolve gitnexus at all).
 */
import { describe, expect, it } from "vitest";
import {
  compareGitNexusVersions,
  gitNexusStorageSkewAction,
  globalGitNexusResolveBases,
  isGitNexusStorageSkew,
  rankGitNexusManifests,
  readGitNexusVersion,
} from "../src/gitnexus-reindex.js";

describe("globalGitNexusResolveBases", () => {
  it("probes the muon-cli install's own dependency before a standalone global", () => {
    const bases = globalGitNexusResolveBases({
      npmGlobalRoot: () => "/opt/homebrew/lib/node_modules",
      home: "/Users/op",
    });
    // First pair comes from the live npm root.
    expect(bases[0]).toBe("/opt/homebrew/lib/node_modules/muon-cli");
    // The standalone probe is the PARENT of the root: require.resolve with
    // paths=[/opt/homebrew/lib] finds /opt/homebrew/lib/node_modules/gitnexus.
    expect(bases[1]).toBe("/opt/homebrew/lib");
  });

  it("still probes the conventional prefixes when npm is not spawnable", () => {
    const bases = globalGitNexusResolveBases({
      npmGlobalRoot: () => null,
      home: "/Users/op",
    });
    expect(bases).toContain("/opt/homebrew/lib/node_modules/muon-cli");
    expect(bases).toContain("/usr/local/lib/node_modules/muon-cli");
    expect(bases).toContain("/Users/op/.npm-global/lib/node_modules/muon-cli");
    expect(bases).toContain("/usr/local/lib");
  });

  it("deduplicates when the live root IS a conventional prefix", () => {
    const bases = globalGitNexusResolveBases({
      npmGlobalRoot: () => "/usr/local/lib/node_modules/",
      home: "/Users/op",
    });
    const muonCli = bases.filter(
      (b) => b === "/usr/local/lib/node_modules/muon-cli"
    );
    expect(muonCli).toHaveLength(1);
  });
});

/**
 * Store-format skew (measured on a real 0.4.8 install, 2026-08-20): the
 * machine's global gitnexus 1.6.9 had written the store at DB version 42 and
 * MUON's exact pin 1.6.5 could only read 40, so every code-graph tool failed.
 * A newer reader opens an older store; the reverse is impossible — so the
 * resolver must pick the NEWEST copy, not the first found.
 */
describe("compareGitNexusVersions", () => {
  it("orders by numeric segment", () => {
    expect(compareGitNexusVersions("1.6.9", "1.6.5")).toBeGreaterThan(0);
    expect(compareGitNexusVersions("1.6.5", "1.6.9")).toBeLessThan(0);
    expect(compareGitNexusVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareGitNexusVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareGitNexusVersions("1.6.5", "1.6.5")).toBe(0);
  });

  it("treats an unreadable version as NOT newer — never invents an order", () => {
    expect(compareGitNexusVersions(null, "1.6.5")).toBeLessThan(0);
    expect(compareGitNexusVersions("1.6.5", null)).toBeGreaterThan(0);
    expect(compareGitNexusVersions(null, null)).toBe(0);
  });

  it("ignores prerelease suffixes rather than mis-ordering them", () => {
    expect(compareGitNexusVersions("1.7.0-rc.1", "1.6.9")).toBeGreaterThan(0);
  });
});

describe("rankGitNexusManifests", () => {
  it("orders candidates newest-first", () => {
    const ranked = rankGitNexusManifests(
      ["/install", "/global"],
      (base) => `${base}/pkg.json`,
      (path) => (path.startsWith("/global") ? "1.6.9" : "1.6.5")
    );
    expect(ranked.map((c) => c.manifestPath)).toEqual([
      "/global/pkg.json",
      "/install/pkg.json",
    ]);
  });

  it("keeps discovery order on a tie — locality breaks ties only", () => {
    const ranked = rankGitNexusManifests(
      ["/local", "/global"],
      (base) => `${base}/pkg.json`,
      () => "1.6.9"
    );
    expect(ranked[0]?.manifestPath).toBe("/local/pkg.json");
  });

  it("returns EVERY candidate, so a refused winner has a fallback", () => {
    // The whole point of ranking rather than picking: LadybugDB's storage
    // check is exact, so the newest copy can still be the wrong one.
    const ranked = rankGitNexusManifests(
      ["/a", "/b", "/c"],
      (base) => `${base}/pkg.json`,
      (path) => (path.startsWith("/b") ? "2.0.0" : "1.0.0")
    );
    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.manifestPath).toBe("/b/pkg.json");
  });

  it("skips unresolvable bases and dedupes a shared manifest", () => {
    const reads: string[] = [];
    const ranked = rankGitNexusManifests(
      ["/a", "/missing", "/b"],
      (base) => (base === "/missing" ? null : "/shared/pkg.json"),
      (path) => {
        reads.push(path);
        return "1.6.5";
      }
    );
    expect(ranked).toHaveLength(1);
    expect(reads).toHaveLength(1);
  });

  it("still ranks a candidate whose version cannot be read (it just cannot win)", () => {
    const ranked = rankGitNexusManifests(
      ["/unknown", "/known"],
      (base) => `${base}/pkg.json`,
      (path) => (path.startsWith("/known") ? "1.0.0" : null)
    );
    expect(ranked.map((c) => c.manifestPath)).toEqual([
      "/known/pkg.json",
      "/unknown/pkg.json",
    ]);
  });
});

describe("readGitNexusVersion", () => {
  it("reads a version, and reports null rather than throwing on junk", () => {
    expect(readGitNexusVersion("/x", () => '{"version":"1.6.9"}')).toBe("1.6.9");
    expect(readGitNexusVersion("/x", () => "not json")).toBeNull();
    expect(readGitNexusVersion("/x", () => '{"version":42}')).toBeNull();
    expect(
      readGitNexusVersion("/x", () => {
        throw new Error("ENOENT");
      })
    ).toBeNull();
  });
});

describe("isGitNexusStorageSkew", () => {
  it("recognises the real LadybugDB skew message", () => {
    expect(
      isGitNexusStorageSkew(
        "LadybugDB unavailable for muon. Another process may be rebuilding the index. Retry later. (Runtime exception: Trying to read a database file with a different version. Database file version: 42, Current build storage version: 40)"
      )
    ).toBe(true);
  });

  it("does NOT claim skew for an ordinary missing index", () => {
    expect(isGitNexusStorageSkew("No indexed GitNexus repository contains this workspace.")).toBe(false);
    expect(isGitNexusStorageSkew("Command failed: gitnexus query")).toBe(false);
  });

  it("store NEWER than reader: forbids re-analyzing and names both remedies", () => {
    const action = gitNexusStorageSkewAction(
      "Database file version: 42, Current build storage version: 40"
    );
    expect(action).toContain("NEWER");
    expect(action).toContain("muon update");
    expect(action).toContain("MUON_GITNEXUS_BIN");
    expect(action).toMatch(/Do NOT re-run/);
    // Resolution is memoized per process — an export without a restart repeats
    // the identical failure.
    expect(action).toContain("Restart this session");
  });

  it("store OLDER than reader: re-analyzing IS the fix, and must be told so", () => {
    const action = gitNexusStorageSkewAction(
      "Database file version: 40, Current build storage version: 42"
    );
    expect(action).toContain("OLDER");
    expect(action).toContain("gitnexus analyze --index-only --force");
    expect(action).not.toMatch(/Do NOT re-run/);
  });

  it("falls back to the safe direction when the numbers are unreadable", () => {
    const action = gitNexusStorageSkewAction("a different version, unspecified");
    expect(action).toMatch(/Do NOT re-run/);
  });
});
