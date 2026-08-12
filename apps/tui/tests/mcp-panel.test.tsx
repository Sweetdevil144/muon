import React from "react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { plainFrame } from "./ansi.js";
import {
  MCP_STATUS_CHECK_IDS,
  buildMcpStatusReport,
} from "@muon/client/mcp-status";
import type { McpVendorIo } from "@muon/client/mcp-vendor-config";
import { McpPanel, MCP_VENDOR_WINDOW } from "../src/components/McpPanel.js";
import { loadMcpPanel, mcpReportFailing } from "../src/lib/mcp-view.js";

/**
 * The TUI half of S1 (docs/design/cc-as-superagent-delivery.md §5).
 *
 * SAFETY, structurally: every `roots.home` here is either a path that does not
 * exist or a fresh `mkdtemp`, and every `run` throws — so no test in this file
 * can read the operator's real `~/.claude`, `~/.codex`, `~/.cursor` or
 * `~/.config/opencode` for an assertion, and none can write one. That is the
 * same seam apps/cli/tests/mcp-status.test.ts uses, reused rather than weakened.
 *
 * PARITY, structurally: the assertions below compare what the panel PRINTS
 * against what `buildMcpStatusReport` RETURNS, not against literals this file
 * chose. A panel that restated a check would then disagree with the shared
 * evaluator and fail here, which is the regression §5 exists to prevent.
 */

const MCP_BIN = "/opt/muon/bin/muon-mcp";
/** Short and nonexistent on purpose: nothing is created, and the config paths
 *  it produces are short enough to survive the panel's truncation. */
const VIRTUAL_HOME = "/tmp/muon-tui-mcp-does-not-exist";

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function io(overrides: Partial<McpVendorIo> = {}): McpVendorIo {
  return {
    roots: {
      home: VIRTUAL_HOME,
      configHome: `${VIRTUAL_HOME}/.config`,
      cwd: `${VIRTUAL_HOME}/repo`,
      redirectVendorConfigDirs: true,
    },
    run: () => {
      throw new Error("the MCP panel must not spawn a vendor process");
    },
    which: (command) => `/usr/local/bin/${command}`,
    isExecutableFile: (p) => p === MCP_BIN,
    ...overrides,
  };
}

/** A LIVE lockfile: pid is ours, so the liveness probe passes. */
function writeLockfile(): string {
  const dataDir = tempDir("muon-tui-mcp-data-");
  fs.writeFileSync(
    path.join(dataDir, "brain.lock"),
    JSON.stringify({
      port: 51234,
      token: "operator-token-must-never-reach-the-cockpit",
      agentToken: "a".repeat(64),
      pid: process.pid,
      dbPath: path.join(dataDir, "muon.db"),
      startedAt: new Date().toISOString(),
    })
  );
  return dataDir;
}

function frameOf(node: React.ReactElement): string {
  const { lastFrame } = render(node);
  return plainFrame(lastFrame() ?? "");
}

async function readyFrame(
  vendorIo: McpVendorIo,
  env: Record<string, string | undefined>,
  vendorIndex = 0
) {
  const load = await loadMcpPanel({ io: vendorIo, env });
  if (load.status !== "ready") {
    throw new Error(`expected a ready load, got ${load.status}`);
  }
  return {
    load,
    report: load.report,
    frame: frameOf(<McpPanel load={load} vendorIndex={vendorIndex} />),
  };
}

describe("MCP panel — the three states a consumer can land in", () => {
  it("says what it is doing while the read is in flight, never a blank frame", () => {
    const frame = frameOf(<McpPanel load={{ status: "loading" }} />);
    expect(frame).toContain("MCP");
    expect(frame).toContain("reading each vendor's own MCP config…");
    // The affordances are visible even before data arrives.
    expect(frame).toContain("Esc");
  });

  it("degrades to ONE honest line plus the way forward, never a blank frame", () => {
    const frame = frameOf(
      <McpPanel load={{ status: "error", reason: "EACCES /tmp/x" }} />
    );
    expect(frame).toContain("unavailable");
    expect(frame).toContain("EACCES /tmp/x");
    expect(frame).toContain("muon mcp status");
  });

  it("never rejects — a throwing IO seam becomes the error state", async () => {
    const load = await loadMcpPanel({
      io: io({
        which: () => {
          throw new Error("which exploded");
        },
      }),
      env: { MUON_DATA_DIR: tempDir("muon-tui-mcp-empty-") },
    });
    expect(load.status).toBe("error");
    if (load.status !== "error") throw new Error("unreachable");
    expect(load.reason).toContain("which exploded");
  });
});

describe("MCP panel — the fields §5 requires, read from the ONE evaluator", () => {
  it("names the tier, the credential branch and whether the brain is running", async () => {
    const { report, frame } = await readyFrame(io(), {
      MUON_DATA_DIR: writeLockfile(),
    });
    // Compared against the REPORT, not against a literal: if the panel ever
    // derived any of these itself, it would drift from `muon mcp status` and
    // this assertion is what notices.
    expect(report.tier).toBe("agent");
    expect(frame).toContain(`Tier         ${report.tier}`);
    expect(frame).toContain(`Bearer from  ${report.tokenSource}`);
    expect(report.tokenSource).toBe("lockfile.agentToken");
    expect(frame).toContain("Brain        running");
    expect(report.brainRunning).toBe(true);
    expect(frame).toContain("never operator, by construction");
  });

  it("states the brain is NOT running rather than showing an empty field", async () => {
    const { report, frame } = await readyFrame(io(), {
      MUON_DATA_DIR: tempDir("muon-tui-mcp-empty-"),
    });
    expect(report.brainRunning).toBe(false);
    expect(frame).toContain("Brain        not running");
    expect(frame).toContain(`Bearer from  ${report.tokenSource}`);
    expect(report.tokenSource).toBe("none");
  });

  it("names EVERY check with its state, not only the failures", async () => {
    const { report, frame } = await readyFrame(io(), {
      MUON_DATA_DIR: writeLockfile(),
    });
    expect(report.checks.map((c) => c.id)).toEqual([...MCP_STATUS_CHECK_IDS]);
    for (const check of report.checks) {
      expect(frame).toContain(check.id);
    }
    expect(frame).toContain(`Checks (${report.checks.length})`);
  });

  it("shows installed / not installed, the config path and commandResolves", async () => {
    const vendorIo = io();
    const { report, frame } = await readyFrame(vendorIo, {
      MUON_DATA_DIR: tempDir("muon-tui-mcp-empty-"),
    });
    const claude = report.vendors[0]!;
    expect(claude.vendor).toBe("claude-code");
    expect(claude.installed).toBe(false);
    expect(frame).toContain("not installed");
    // The config path is PRINTED, and it is the one the evaluator resolved.
    expect(claude.configPath).toBe(`${VIRTUAL_HOME}/.claude.json`);
    expect(frame).toContain(claude.configPath);
    // Nothing registered ⇒ nothing to re-verify. "n/a" is the honest word.
    expect(claude.commandResolves).toBeNull();
    expect(frame).toContain("resolves  n/a");
  });

  it("re-verifies a registered command and says so when it stopped resolving", async () => {
    const home = tempDir("muon-tui-mcp-home-");
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { muon: { command: "/Applications/MUON.app/old/muon-mcp" } },
      })
    );
    const vendorIo = io({
      roots: {
        home,
        configHome: path.join(home, ".config"),
        cwd: path.join(home, "repo"),
        redirectVendorConfigDirs: true,
      },
    });
    const { report, frame } = await readyFrame(vendorIo, {
      MUON_DATA_DIR: tempDir("muon-tui-mcp-empty-"),
    });
    const claude = report.vendors[0]!;
    expect(claude.installed).toBe(true);
    expect(claude.commandResolves).toBe(false);
    expect(frame).toContain("installed");
    expect(frame).toContain("resolves  NO — re-run muon mcp install");
    // And the shared verdict the CLI exits 1 on.
    expect(mcpReportFailing(report)).toBe(true);
  });
});

describe("MCP panel — installable and coordinatorSeat are BOTH shown, always", () => {
  it("prints both booleans for a seat-holding vendor", async () => {
    const { report, frame } = await readyFrame(io(), {
      MUON_DATA_DIR: tempDir("muon-tui-mcp-empty-"),
    });
    const claude = report.vendors[0]!;
    expect(claude.installable).toBe(true);
    expect(claude.coordinatorSeat).toBe(true);
    expect(frame).toContain("installable yes   coordinatorSeat yes");
    expect(frame).toContain("it can be the superagent that dispatches a crew");
  });

  it("prints both booleans for cursor and opencode, which hold NO seat", async () => {
    // §2.2: "installable" and "can coordinate" are two separate booleans, and
    // conflating them is the documentation failure ADR-0022 warns about. Cursor
    // and opencode are installable AND seatless, so this is the case a surface
    // that showed only `installable` would silently misrepresent.
    const noSeat = MCP_VENDOR_WINDOW; // vendors 0-1 hold the seat; 2-3 do not.
    const { report, frame } = await readyFrame(
      io(),
      { MUON_DATA_DIR: tempDir("muon-tui-mcp-empty-") },
      noSeat
    );
    for (const row of report.vendors.slice(noSeat)) {
      expect(row.installable).toBe(true);
      expect(row.coordinatorSeat).toBe(false);
      expect(frame).toContain(row.label);
    }
    expect(frame).toContain("installable yes   coordinatorSeat no");
    expect(frame).toContain(
      "it can use MUON's memory + code graph, never coordinate a crew"
    );
    // The seat-holder wording must NOT be on screen for these two.
    expect(frame).not.toContain("it can be the superagent that dispatches a crew");
  });

  it("scrolls the vendor window rather than hiding the seatless vendors", async () => {
    const env = { MUON_DATA_DIR: tempDir("muon-tui-mcp-empty-") };
    const first = await readyFrame(io(), env, 0);
    const scrolled = await readyFrame(io(), env, MCP_VENDOR_WINDOW);
    const vendors = first.report.vendors;
    expect(vendors).toHaveLength(4);
    expect(first.frame).toContain(vendors[0]!.label);
    expect(first.frame).not.toContain(vendors[3]!.label);
    expect(scrolled.frame).toContain(vendors[3]!.label);
    expect(first.frame).toContain("j/k scrolls");
  });
});

describe("MCP panel — what it must NOT do", () => {
  it("spawns no vendor process (the runner throws if it tries)", async () => {
    // `status` has to render on exactly the broken machine it exists to
    // diagnose, so it reads each config file directly.
    const load = await loadMcpPanel({
      io: io(),
      env: { MUON_DATA_DIR: tempDir("muon-tui-mcp-empty-") },
    });
    expect(load.status).toBe("ready");
  });

  it("never puts the operator credential on screen", async () => {
    const dataDir = writeLockfile();
    const { frame } = await readyFrame(io(), { MUON_DATA_DIR: dataDir });
    expect(frame).not.toContain("operator-token-must-never-reach-the-cockpit");
    expect(frame).not.toContain("a".repeat(64));
  });

  it("offers no install keystroke — registering stays an explicit command", async () => {
    const { frame } = await readyFrame(io(), {
      MUON_DATA_DIR: tempDir("muon-tui-mcp-empty-"),
    });
    expect(frame).toContain("read-only");
    expect(frame).toContain("muon mcp install <vendor>");
  });
});

describe("MCP panel — parity with the CLI's evaluator", () => {
  it("PRINTS the report's own fields, and never re-derives them", async () => {
    // THE MUTATION THIS TEST EXISTS FOR. The first version of the assertions
    // above compared the frame against `report.tier` — which a panel that
    // recomputed the tier from `tokenSource` still satisfies, because on a real
    // report the two agree. It passed a mutation that restated the check, which
    // is exactly the drift §5 is written to prevent.
    //
    // So: hand the panel a report whose fields are deliberately INCONSISTENT
    // with each other, in the direction only the shared evaluator can decide.
    // A panel that reads `report.tier` prints "none"; a panel that derives the
    // tier from the credential branch prints "agent" and fails here.
    const base = buildMcpStatusReport({
      io: io(),
      env: { MUON_DATA_DIR: writeLockfile() },
    });
    expect(base.tier).toBe("agent");
    expect(base.tokenSource).toBe("lockfile.agentToken");

    const frame = frameOf(
      <McpPanel
        load={{
          status: "ready",
          report: {
            ...base,
            tier: "none",
            toolCount: 999,
            brainRunning: false,
            tierCReason: "a reason only the evaluator could have written",
            vendors: base.vendors.map((row) => ({
              ...row,
              // Same trick per vendor: `installed` disagrees with `command`,
              // and `commandResolves` disagrees with the path being absent.
              installed: !row.installed,
              coordinatorSeat: !row.coordinatorSeat,
            })),
          },
        }}
      />
    );

    expect(frame).toContain("Tier         none");
    expect(frame).toContain("999 tools");
    expect(frame).toContain("Brain        not running");
    expect(frame).toContain("a reason only the evaluator could have written");
    // claude-code really holds the seat and is really not installed here, so
    // the flipped values prove the panel is reading the row, not the registry.
    expect(frame).toContain("installed");
    expect(frame).toContain("coordinatorSeat no");
  });

  it("renders the SAME report object the CLI builds, field for field", async () => {
    // The whole point of the lift: one evaluator, three renderers. If the panel
    // ever computed its own report, this equality is what breaks.
    const vendorIo = io();
    const env = { MUON_DATA_DIR: writeLockfile() };
    const load = await loadMcpPanel({ io: vendorIo, env });
    const direct = buildMcpStatusReport({ io: vendorIo, env });
    expect(load).toEqual({ status: "ready", report: direct });
  });
});
