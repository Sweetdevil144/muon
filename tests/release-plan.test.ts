import { describe, expect, it } from "vitest";
import {
  aliasCommands,
  checksummedArtifacts,
  feedNamesVersion,
  publicChecks,
  releaseArtifacts,
} from "../scripts/lib/release-plan.mjs";

// The release pipeline's artifact contract. These names are load-bearing far
// beyond the script: the website's download button, install.sh, and
// electron-updater's feed all address artifacts by these exact names — a drift
// here is a 404 for every user. Distribution is curl/install.sh only; there is
// no package-manager recipe to keep in step.

describe("releaseArtifacts", () => {
  it("publishes the complete v1-shaped set for a version", () => {
    const names = releaseArtifacts("0.1.0").map((a) => a.name);
    expect(names).toEqual([
      "latest-mac.yml",
      "SHA256SUMS",
      "latest-cli.json",
      "MUON-0.1.0-arm64.dmg.blockmap",
      "MUON-0.1.0-arm64-mac.zip.blockmap",
      "muon-cli-0.1.0.tgz",
      "MUON-0.1.0-arm64-mac.zip",
      "MUON-0.1.0-arm64.dmg",
    ]);
  });

  it("uploads small files first so a broken transport fails fast", () => {
    const names = releaseArtifacts("0.1.0").map((a) => a.name);
    expect(names.indexOf("latest-mac.yml")).toBeLessThan(
      names.indexOf("MUON-0.1.0-arm64.dmg")
    );
    expect(names.at(-1)).toBe("MUON-0.1.0-arm64.dmg");
  });

  it("refuses a non-semver version instead of publishing garbage names", () => {
    expect(() => releaseArtifacts("latest")).toThrow(/not a semver/);
    expect(() => releaseArtifacts("0.1")).toThrow(/not a semver/);
    // Path traversal through a version string must be structurally impossible.
    expect(() => releaseArtifacts("../../../etc/passwd")).toThrow(/not a semver/);
  });

  it("keeps the two stable-URL aliases the website and install.sh depend on", () => {
    const aliases = releaseArtifacts("0.2.0")
      .filter((a) => a.alias)
      .map((a) => a.alias);
    expect(aliases).toEqual(["muon-cli-latest.tgz", "MUON-latest-arm64.dmg"]);
  });
});

describe("checksummedArtifacts", () => {
  it("covers everything except the sums file, which cannot checksum itself", () => {
    const sums = checksummedArtifacts("0.1.0");
    expect(sums).not.toContain("SHA256SUMS");
    expect(sums).toContain("MUON-0.1.0-arm64.dmg");
    expect(sums).toContain("muon-cli-0.1.0.tgz");
  });
});

describe("aliasCommands", () => {
  it("copies on the host, never re-uploads", () => {
    expect(aliasCommands("0.1.0")).toEqual([
      "cp /data/muon-cli-0.1.0.tgz /data/muon-cli-latest.tgz",
      "cp /data/MUON-0.1.0-arm64.dmg /data/MUON-latest-arm64.dmg",
    ]);
  });
});

describe("publicChecks", () => {
  it("demands no-cache on the feed and every latest alias", () => {
    const checks = publicChecks("0.1.0");
    const noCache = checks.filter((c) => c.noCache).map((c) => c.url);
    expect(noCache).toEqual([
      "https://download.getmuon.com/latest-mac.yml",
      "https://download.getmuon.com/muon-cli-latest.tgz",
      "https://download.getmuon.com/MUON-latest-arm64.dmg",
    ]);
  });

  it("checks every published artifact URL", () => {
    const urls = publicChecks("0.1.0").map((c) => c.url);
    for (const a of releaseArtifacts("0.1.0")) {
      expect(urls).toContain(`https://download.getmuon.com/${a.name}`);
    }
  });
});

describe("feedNamesVersion", () => {
  it("accepts the feed electron-builder wrote for this version", () => {
    const feed = "version: 0.1.0\nfiles:\n  - url: MUON-0.1.0-arm64-mac.zip\n";
    expect(feedNamesVersion(feed, "0.1.0")).toBe(true);
  });

  it("rejects a stale feed from a previous build directory", () => {
    const feed = "version: 0.0.9\nfiles:\n  - url: MUON-0.0.9-arm64-mac.zip\n";
    expect(feedNamesVersion(feed, "0.1.0")).toBe(false);
  });
});
