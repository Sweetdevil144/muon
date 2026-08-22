import { describe, expect, it } from "vitest";
import {
  CLI_BIN_NAMES,
  CLI_SHIM_MARKER,
  cliEntryFile,
  cliResourcesDir,
  defaultCliBinDir,
  isMuonOwnedShim,
  planLink,
  planUnlink,
  readLinkStatus,
  resolveAppBundlePath,
  shimScript,
  type CliBinName,
  type ExistingBin,
} from "../src/lib/cli-link.js";

/**
 * Settings -> Command Line Tools — the pure link/unlink decision. Founder
 * request, 2026-08-17: "download package + install should install desktop
 * app = mcp/cli/tui". These tests are the ones the fence explicitly calls
 * for: the write/skip/refuse decision, tested without a real filesystem.
 */

function absentAll(): Record<CliBinName, ExistingBin> {
  return { muon: { exists: false }, "muon-tui": { exists: false }, "muon-mcp": { exists: false } };
}

function withOne(
  bin: CliBinName,
  entry: ExistingBin,
  base: Record<CliBinName, ExistingBin> = absentAll()
): Record<CliBinName, ExistingBin> {
  return { ...base, [bin]: entry };
}

const BUNDLE = "/Applications/MUON.app";

describe("resolveAppBundlePath", () => {
  it("resolves the .app root two hops above Contents/Resources", () => {
    expect(
      resolveAppBundlePath("/Applications/MUON.app/Contents/Resources")
    ).toBe("/Applications/MUON.app");
  });

  it("resolves against a non-/Applications install the same way", () => {
    expect(
      resolveAppBundlePath("/Users/me/Downloads/MUON.app/Contents/Resources")
    ).toBe("/Users/me/Downloads/MUON.app");
  });

  it("returns null for a path that is not inside a .app bundle (dev/unpackaged run)", () => {
    expect(resolveAppBundlePath("/Users/me/repo/apps/desktop/dist")).toBeNull();
  });
});

describe("cliResourcesDir / cliEntryFile / defaultCliBinDir", () => {
  it("points at <bundle>/Contents/Resources/cli", () => {
    expect(cliResourcesDir(BUNDLE)).toBe(
      "/Applications/MUON.app/Contents/Resources/cli"
    );
  });
  it("names the staged .mjs entry per bin", () => {
    expect(cliEntryFile("muon")).toBe("muon.mjs");
    expect(cliEntryFile("muon-mcp")).toBe("muon-mcp.mjs");
  });
  it("targets ~/.local/bin, never /usr/local/bin", () => {
    expect(defaultCliBinDir("/Users/me")).toBe("/Users/me/.local/bin");
  });
});

describe("shimScript / isMuonOwnedShim", () => {
  it("carries the exact marker line, verbatim", () => {
    const script = shimScript("muon", BUNDLE);
    expect(script.split("\n")[1]).toBe(CLI_SHIM_MARKER);
    expect(isMuonOwnedShim(script)).toBe(true);
  });

  it("execs the right entry file for each bin", () => {
    expect(shimScript("muon", BUNDLE)).toContain(
      `"$APP/Contents/Resources/cli/muon.mjs"`
    );
    expect(shimScript("muon-tui", BUNDLE)).toContain(
      `"$APP/Contents/Resources/cli/muon-tui.mjs"`
    );
    expect(shimScript("muon-mcp", BUNDLE)).toContain(
      `"$APP/Contents/Resources/cli/muon-mcp.mjs"`
    );
  });

  it("resolves at RUN time, not just from the baked path: override, baked, /Applications, mdfind, in that order", () => {
    const script = shimScript("muon", BUNDLE);
    expect(script).toContain('$MUON_APP_BUNDLE');
    expect(script).toContain(BUNDLE);
    expect(script).toContain("/Applications/MUON.app");
    expect(script).toContain("mdfind");
    expect(script).toContain("dev.muonlabs.muon");
  });

  it("is false for arbitrary content, including another vendor's real binary", () => {
    expect(isMuonOwnedShim("#!/bin/sh\necho hi\n")).toBe(false);
    expect(isMuonOwnedShim("")).toBe(false);
  });

  it("survives a hostile bundle path (embedded single quote) without breaking the shell assignment", () => {
    const script = shimScript("muon", "/Applications/it's.app");
    // The single quote must be escaped, not left to close the quoted string early.
    expect(script).toContain(String.raw`'/Applications/it'\''s.app'`);
  });
});

describe("planLink", () => {
  it("writes when nothing exists at the target", () => {
    const plan = planLink({ binDir: "/home/x/.local/bin", bundlePath: BUNDLE, existing: absentAll() });
    for (const entry of plan.entries) {
      expect(entry.action).toBe("write");
      if (entry.action === "write") {
        expect(entry.reason).toBe("absent");
        expect(entry.content).toBe(shimScript(entry.bin, BUNDLE));
      }
    }
  });

  it("is idempotent: a MUON-owned shim with identical content is already-linked, and writes nothing", () => {
    const content = shimScript("muon", BUNDLE);
    const plan = planLink({
      binDir: "/home/x/.local/bin",
      bundlePath: BUNDLE,
      existing: withOne("muon", { exists: true, content }),
    });
    const muonEntry = plan.entries.find((e) => e.bin === "muon")!;
    expect(muonEntry.action).toBe("already-linked");
  });

  it("re-writes a MUON-owned shim whose content is stale (e.g. the app moved)", () => {
    const staleContent = shimScript("muon", "/Applications/Old MUON.app");
    const plan = planLink({
      binDir: "/home/x/.local/bin",
      bundlePath: BUNDLE,
      existing: withOne("muon", { exists: true, content: staleContent }),
    });
    const muonEntry = plan.entries.find((e) => e.bin === "muon")!;
    expect(muonEntry.action).toBe("write");
    if (muonEntry.action === "write") {
      expect(muonEntry.reason).toBe("stale");
      expect(muonEntry.content).toBe(shimScript("muon", BUNDLE));
    }
  });

  it("REFUSES to overwrite a file MUON did not write, and names the exact path in the reason", () => {
    const plan = planLink({
      binDir: "/home/x/.local/bin",
      bundlePath: BUNDLE,
      existing: withOne("muon", {
        exists: true,
        content: "#!/usr/bin/env node\n// a real npm-installed muon\n",
      }),
    });
    const muonEntry = plan.entries.find((e) => e.bin === "muon")!;
    expect(muonEntry.action).toBe("refused");
    if (muonEntry.action === "refused") {
      expect(muonEntry.reason).toContain("/home/x/.local/bin/muon");
      expect(muonEntry.reason).toContain("not installed by MUON");
    }
    // The other two bins are UNAFFECTED by the muon refusal — per-binary,
    // never all-or-nothing.
    expect(plan.entries.find((e) => e.bin === "muon-tui")!.action).toBe("write");
    expect(plan.entries.find((e) => e.bin === "muon-mcp")!.action).toBe("write");
  });

  it("REFUSES for an unreadable existing entry too (a directory, e.g.) — never assumes ownership", () => {
    const plan = planLink({
      binDir: "/home/x/.local/bin",
      bundlePath: BUNDLE,
      existing: withOne("muon-mcp", { exists: true /* no content: unreadable/dir */ }),
    });
    expect(plan.entries.find((e) => e.bin === "muon-mcp")!.action).toBe("refused");
  });

  it("covers exactly the three bins, every time", () => {
    const plan = planLink({ binDir: "/x", bundlePath: BUNDLE, existing: absentAll() });
    expect(plan.entries.map((e) => e.bin).sort()).toEqual([...CLI_BIN_NAMES].sort());
  });
});

describe("planUnlink", () => {
  it("is absent when nothing exists", () => {
    const plan = planUnlink({ binDir: "/home/x/.local/bin", existing: absentAll() });
    for (const entry of plan.entries) expect(entry.action).toBe("absent");
  });

  it("removes exactly the MUON-owned entries", () => {
    const content = shimScript("muon", BUNDLE);
    const plan = planUnlink({
      binDir: "/home/x/.local/bin",
      existing: withOne("muon", { exists: true, content }),
    });
    expect(plan.entries.find((e) => e.bin === "muon")!.action).toBe("remove");
    expect(plan.entries.find((e) => e.bin === "muon-tui")!.action).toBe("absent");
  });

  it("SKIPS (never removes) a foreign file, and says why", () => {
    const plan = planUnlink({
      binDir: "/home/x/.local/bin",
      existing: withOne("muon", { exists: true, content: "#!/bin/sh\necho not-muon\n" }),
    });
    const entry = plan.entries.find((e) => e.bin === "muon")!;
    expect(entry.action).toBe("skip");
    if (entry.action === "skip") {
      expect(entry.reason).toContain("not installed by MUON");
    }
  });

  it("is undoable: link then unlink returns to fully absent", () => {
    const linkPlan = planLink({ binDir: "/x/.local/bin", bundlePath: BUNDLE, existing: absentAll() });
    const afterLink: Record<CliBinName, ExistingBin> = {} as Record<CliBinName, ExistingBin>;
    for (const entry of linkPlan.entries) {
      if (entry.action === "write") afterLink[entry.bin] = { exists: true, content: entry.content };
    }
    const unlinkPlan = planUnlink({ binDir: "/x/.local/bin", existing: afterLink });
    for (const entry of unlinkPlan.entries) expect(entry.action).toBe("remove");
  });
});

describe("readLinkStatus", () => {
  it("reports absent / linked-current / linked-stale / foreign per bin, without writing anything", () => {
    const current = shimScript("muon", BUNDLE);
    const stale = shimScript("muon-tui", "/Applications/Old.app");
    const existing = withOne(
      "muon",
      { exists: true, content: current },
      withOne("muon-tui", { exists: true, content: stale })
    );
    const entries = readLinkStatus({ binDir: "/x/.local/bin", bundlePath: BUNDLE, existing });
    expect(entries.find((e) => e.bin === "muon")!.state).toBe("linked-current");
    expect(entries.find((e) => e.bin === "muon-tui")!.state).toBe("linked-stale");
    expect(entries.find((e) => e.bin === "muon-mcp")!.state).toBe("absent");
  });

  it("reports foreign for a non-MUON file, distinct from absent", () => {
    const entries = readLinkStatus({
      binDir: "/x/.local/bin",
      bundlePath: BUNDLE,
      existing: withOne("muon-mcp", { exists: true, content: "not ours" }),
    });
    expect(entries.find((e) => e.bin === "muon-mcp")!.state).toBe("foreign");
  });
});

/**
 * The shim's NODE_PATH export is one half of a two-part contract (2026-08-20):
 * `stage-cli.mjs` PRUNES the ~300MB `@anthropic-ai/claude-agent-sdk-<os>-<arch>`
 * package from the staged CLI because the app already ships it, and the SDK
 * only finds the app's copy because the shim points NODE_PATH at the unpacked
 * tree. Drop this export and a DMG-linked `muon` loses the ability to start a
 * Claude session — silently, until someone dispatches.
 */
describe("shimScript NODE_PATH (the pruned SDK's other half)", () => {
  it("points NODE_PATH at the app's unpacked node_modules before exec", () => {
    const script = shimScript("muon", "/Applications/MUON.app");
    expect(script).toContain(
      '$APP/Contents/Resources/app.asar.unpacked/node_modules'
    );
    expect(script).toContain("export NODE_PATH");
    // Resolved from $APP, never the link-time literal: the app can move and
    // resolve_app() re-finds it.
    expect(script).not.toContain(
      '"/Applications/MUON.app/Contents/Resources/app.asar.unpacked'
    );
  });

  it("APPENDS to a user's NODE_PATH instead of replacing it", () => {
    const script = shimScript("muon-mcp", "/Applications/MUON.app");
    expect(script).toContain('NODE_PATH="$NODE_PATH:');
  });

  it("exports NODE_PATH before the exec line, for every bin", () => {
    for (const bin of ["muon", "muon-tui", "muon-mcp"] as const) {
      const script = shimScript(bin, "/Applications/MUON.app");
      const exportAt = script.indexOf("export NODE_PATH");
      const execAt = script.indexOf("exec \"$APP");
      expect(exportAt, `${bin} exports NODE_PATH`).toBeGreaterThan(-1);
      expect(execAt, `${bin} execs`).toBeGreaterThan(exportAt);
    }
  });
});
