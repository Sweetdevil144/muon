import { describe, expect, it } from "vitest";
import {
  aliasCommands,
  checksummedArtifacts,
  feedNamesVersion,
  publicChecks,
  pruneCommands,
  releaseArtifacts,
  rollbackCommands,
  snapshotCommands,
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
      "ln -f /data/muon-cli-0.1.0.tgz /data/muon-cli-latest.tgz",
      "ln -f /data/MUON-0.1.0-arm64.dmg /data/MUON-latest-arm64.dmg",
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

/**
 * Founder policy (2026-08-20): snapshot the live release, prune everything
 * else, upload, verify, then retire the old names. The invariant that earns
 * its own assertions: uploads REWRITE feeds in place (`cat >`), so the
 * snapshot must COPY the three feed files — a hardlinked feed would be
 * truncated at the exact moment it becomes the only rollback.
 */
describe("snapshot / prune / rollback commands", () => {
  it("snapshots versioned artifacts as hardlinks and feeds as copies", () => {
    const cmds = snapshotCommands("0.4.8").join("\n");
    expect(cmds).toContain("rm -rf /data/.rollback && mkdir -p /data/.rollback/0.4.8");
    expect(cmds).toContain('ln -f "/data/MUON-0.4.8-arm64.dmg" "/data/.rollback/0.4.8/MUON-0.4.8-arm64.dmg"');
    expect(cmds).toContain('cp "/data/latest-mac.yml" "/data/.rollback/0.4.8/latest-mac.yml"');
    // NEVER a hardlinked feed.
    expect(cmds).not.toContain('ln -f "/data/latest-mac.yml"');
    expect(cmds).not.toContain('ln -f "/data/SHA256SUMS"');
    expect(cmds).not.toContain('ln -f "/data/latest-cli.json"');
  });

  it("prune keeps both named versions and the two aliases, removes strays", () => {
    const cmd = pruneCommands("0.4.8", "0.4.9")[0];
    expect(cmd).toContain('"MUON-0.4.8-arm64.dmg"');
    expect(cmd).toContain('"MUON-0.4.9-arm64.dmg"');
    expect(cmd).toContain('"MUON-latest-arm64.dmg"');
    expect(cmd).toContain('"muon-cli-latest.tgz"');
    expect(cmd).toContain("rm -f");
    // Feeds are not in the glob set at all.
    expect(cmd).not.toContain("latest-mac.yml");
  });

  it("the post-verify prune keeps ONLY the new release", () => {
    const cmd = pruneCommands("0.4.9")[0];
    expect(cmd).toContain('"MUON-0.4.9-arm64.dmg"');
    expect(cmd).not.toContain("0.4.8");
  });

  it("rollback restores names as hardlinks, feeds as copies, and re-points aliases", () => {
    const cmds = rollbackCommands("0.4.8").join("\n");
    expect(cmds).toContain('ln -f "/data/.rollback/0.4.8/MUON-0.4.8-arm64.dmg" "/data/MUON-0.4.8-arm64.dmg"');
    expect(cmds).toContain('cp "/data/.rollback/0.4.8/latest-mac.yml" "/data/latest-mac.yml"');
    expect(cmds).toContain("MUON-latest-arm64.dmg");
    expect(cmds).toContain("muon-cli-latest.tgz");
  });
});
