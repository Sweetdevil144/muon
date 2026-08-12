import path from "node:path";
import { describe, expect, it } from "vitest";
import { VENDOR_IDS } from "@muon/protocol";
import { MUON_MCP_SERVER_NAME } from "@muon/core";
import {
  INSTALLABLE_VENDORS,
  MUON_MCP_ENTRY_NAME,
  installableRemainder,
  resolveInstallableVendor,
  resolveMuonMcpCommand,
  vendorChildEnv,
  vendorConfigPath,
  vendorHoldsCoordinatorSeat,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";

function io(overrides: Partial<McpVendorIo> = {}): McpVendorIo {
  return {
    roots: {
      home: "/tmp/fake-home",
      configHome: "/tmp/fake-home/.config",
      cwd: "/tmp/fake-repo",
      redirectVendorConfigDirs: true,
    },
    run: () => {
      throw new Error("no vendor process should be spawned by this test");
    },
    which: () => null,
    isExecutableFile: () => false,
    ...overrides,
  };
}

describe("the installable-vendor table is positive, never a remainder", () => {
  // ADR-0022 rule 2 + docs/memory: this repo has broken itself three times by
  // defining a set as `SUPERSET − allowed`. If a fifth REAL vendor is added to
  // VENDOR_IDS, this test fails instead of that vendor silently becoming
  // uninstallable with nobody noticing.
  it("excludes exactly the dev-test vendor and nothing else", () => {
    expect(installableRemainder()).toEqual(["fake"]);
  });

  it("covers every non-fake vendor id", () => {
    expect(INSTALLABLE_VENDORS.map((spec) => spec.id).sort()).toEqual(
      VENDOR_IDS.filter((id) => id !== "fake")
        .slice()
        .sort()
    );
  });

  it("keeps 'installable' and 'holds the coordinator seat' as SEPARATE booleans", () => {
    // §2.2: conflating them is the documentation failure ADR-0022 warns about.
    // Two vendors are installable AND seat-holders; two are installable and not.
    const seats = INSTALLABLE_VENDORS.filter((spec) =>
      vendorHoldsCoordinatorSeat(spec.id)
    ).map((spec) => spec.id);
    expect(seats).toEqual(["claude-code", "codex"]);
    const noSeat = INSTALLABLE_VENDORS.filter(
      (spec) => !vendorHoldsCoordinatorSeat(spec.id)
    ).map((spec) => spec.id);
    expect(noSeat).toEqual(["cursor", "opencode"]);
  });

  it("never exposes 'local' as a scope, and defaults claude to user", () => {
    // The measured trap: claude's OWN default scope is `local`, which lands the
    // entry under projects.<cwd> and is invisible from every other repo.
    for (const spec of INSTALLABLE_VENDORS) {
      expect(spec.scopes).not.toContain("local");
      expect(spec.scopes).toContain(spec.defaultScope);
    }
    const claude = resolveInstallableVendor("claude")!;
    expect(claude.defaultScope).toBe("user");
  });

  it("records the live-verified version for every vendor", () => {
    for (const spec of INSTALLABLE_VENDORS) {
      expect(spec.verifiedAt).toMatch(/2026-07-30/);
    }
  });

  it("resolves the aliases a human would actually type", () => {
    expect(resolveInstallableVendor("claude")?.id).toBe("claude-code");
    expect(resolveInstallableVendor("claude-code")?.id).toBe("claude-code");
    expect(resolveInstallableVendor(" Codex ")?.id).toBe("codex");
    expect(resolveInstallableVendor("cursor-agent")?.id).toBe("cursor");
    expect(resolveInstallableVendor("opencode")?.id).toBe("opencode");
    // The dev-test vendor has no MCP config to install into.
    expect(resolveInstallableVendor("fake")).toBeUndefined();
    expect(resolveInstallableVendor("nope")).toBeUndefined();
  });
});

describe("vendor config paths and the child-env isolation seam", () => {
  const roots = io().roots;

  it("maps each vendor+scope to the file measured on 2026-07-30", () => {
    const claude = resolveInstallableVendor("claude")!;
    expect(vendorConfigPath(claude, "user", roots)).toBe(
      "/tmp/fake-home/.claude.json"
    );
    expect(vendorConfigPath(claude, "project", roots)).toBe(
      "/tmp/fake-repo/.mcp.json"
    );
    expect(vendorConfigPath(resolveInstallableVendor("codex")!, "user", roots)).toBe(
      "/tmp/fake-home/.codex/config.toml"
    );
    expect(vendorConfigPath(resolveInstallableVendor("cursor")!, "user", roots)).toBe(
      "/tmp/fake-home/.cursor/mcp.json"
    );
    expect(
      vendorConfigPath(resolveInstallableVendor("cursor")!, "project", roots)
    ).toBe("/tmp/fake-repo/.cursor/mcp.json");
    expect(
      vendorConfigPath(resolveInstallableVendor("opencode")!, "user", roots)
    ).toBe("/tmp/fake-home/.config/opencode/opencode.json");
  });

  it("forces NO env onto a vendor process in production", () => {
    // The production value of `redirectVendorConfigDirs` is false, and this is
    // the assertion that keeps it that way: redirecting a real machine's
    // CLAUDE_CONFIG_DIR would orphan the config the human already has.
    const production = { ...roots, redirectVendorConfigDirs: false };
    for (const spec of INSTALLABLE_VENDORS) {
      expect(vendorChildEnv(spec, production)).toEqual({});
    }
  });

  it("redirects each vendor's own config-dir variable when isolating", () => {
    expect(vendorChildEnv(resolveInstallableVendor("claude")!, roots)).toEqual({
      CLAUDE_CONFIG_DIR: "/tmp/fake-home",
    });
    expect(vendorChildEnv(resolveInstallableVendor("codex")!, roots)).toEqual({
      CODEX_HOME: "/tmp/fake-home/.codex",
    });
    expect(vendorChildEnv(resolveInstallableVendor("cursor")!, roots)).toEqual({
      HOME: "/tmp/fake-home",
    });
    expect(vendorChildEnv(resolveInstallableVendor("opencode")!, roots)).toEqual({
      XDG_CONFIG_HOME: "/tmp/fake-home/.config",
    });
  });
});

describe("D-cmd: resolveMuonMcpCommand resolves, verifies, and records", () => {
  it("prefers a sibling of the running muon binary over PATH", () => {
    const sibling = path.join(
      path.dirname(path.resolve(process.argv[1]!)),
      "muon-mcp"
    );
    const resolved = resolveMuonMcpCommand(
      io({
        which: () => "/somewhere/else/muon-mcp",
        isExecutableFile: (p) => p === sibling || p === "/somewhere/else/muon-mcp",
      })
    );
    expect(resolved).toEqual({
      ok: true,
      command: sibling,
      source: "sibling of the running muon binary",
    });
  });

  it("falls back to PATH when no sibling exists", () => {
    const resolved = resolveMuonMcpCommand(
      io({
        which: (cmd) => (cmd === "muon-mcp" ? "/opt/homebrew/bin/muon-mcp" : null),
        isExecutableFile: (p) => p === "/opt/homebrew/bin/muon-mcp",
      })
    );
    expect(resolved).toEqual({
      ok: true,
      command: "/opt/homebrew/bin/muon-mcp",
      source: "PATH",
    });
  });

  it("falls back to the well-known install dirs the desktop prepends", () => {
    const resolved = resolveMuonMcpCommand(
      io({
        which: () => null,
        isExecutableFile: (p) => p === "/tmp/fake-home/.local/bin/muon-mcp",
      })
    );
    expect(resolved).toEqual({
      ok: true,
      command: "/tmp/fake-home/.local/bin/muon-mcp",
      source: "/tmp/fake-home/.local/bin",
    });
  });

  it("fails CLOSED, listing what it searched, when nothing resolves", () => {
    // The .dmg-only case (§1.4c). MUON must not write a bare `muon-mcp`: that
    // failure happens inside the user's own vendor CLI where MUON has no
    // interpose and no diagnostic.
    const resolved = resolveMuonMcpCommand(io());
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected a refusal");
    }
    expect(resolved.searched.length).toBeGreaterThan(3);
    expect(resolved.searched.every((p) => path.isAbsolute(p))).toBe(true);
  });

  it("owns the same entry name the injected-session path uses", () => {
    // One source of truth with `withMuonMcpServer`, so `uninstall` removes
    // exactly what `install` wrote and never a neighbour.
    //
    // Asserted against the CONSTANT, not just the literal: when this module
    // moved into `@muon/client` it had to stop importing `@muon/core`
    // (client depends only on `@muon/protocol`, and a core edge would drag the
    // vendor SDK into a package the desktop renderer type-imports). It now reads
    // `GOVERNED_MCP_SERVER_NAME`. `apps/cli` depends on BOTH packages, so this is
    // the place the two can be compared directly — `packages/core`'s own
    // governed-mcp-server-name test pins the other half of the same equality.
    expect(MUON_MCP_ENTRY_NAME).toBe(MUON_MCP_SERVER_NAME);
    expect(MUON_MCP_ENTRY_NAME).toBe("muon");
  });
});
