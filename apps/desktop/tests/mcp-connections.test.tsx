// @vitest-environment jsdom

import React from "react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMcpStatusReport } from "@muon/client/mcp-status";
import type { McpVendorIo } from "@muon/client/mcp-vendor-config";
import type { McpInstallReport, McpStatusReport } from "../src/shared/ipc.js";
import { McpConnectionsPanel } from "../src/renderer/sidebar.js";

/**
 * Settings → Connections, S1 of docs/design/cc-as-superagent-delivery.md §5.
 *
 * The fixtures below are NOT hand-written literals: they are built by the ONE
 * shared evaluator (`buildMcpStatusReport`) over an injected IO seam whose
 * `home` is either nonexistent or a fresh `mkdtemp`, and whose `run` THROWS.
 * So (a) no test here can read or write the operator's real `~/.claude`,
 * `~/.codex`, `~/.cursor` or `~/.config/opencode`, and (b) a panel that
 * restated a check or a vendor fact instead of rendering the report would
 * disagree with these assertions.
 */

const MCP_BIN = "/opt/muon/bin/muon-mcp";
const VIRTUAL_HOME = "/tmp/muon-desktop-mcp-does-not-exist";

const tempRoots: string[] = [];
afterEach(() => {
  cleanup();
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
      throw new Error("the Connections row must not spawn a vendor process");
    },
    // `muon-mcp` resolves through PATH in the base fixture, so Install is
    // ENABLED by default and the two "dead end" tests below have to disable it
    // explicitly — the opposite default would let a broken button pass as
    // deliberate.
    which: (command) => (command === "muon-mcp" ? MCP_BIN : `/usr/local/bin/${command}`),
    isExecutableFile: (p) => p === MCP_BIN,
    ...overrides,
  };
}

function report(overrides: Partial<McpVendorIo> = {}): McpStatusReport {
  return buildMcpStatusReport({
    io: io(overrides),
    env: { MUON_DATA_DIR: tempDir("muon-desktop-mcp-empty-") },
  });
}

function panel(props: Partial<React.ComponentProps<typeof McpConnectionsPanel>>) {
  return render(
    <McpConnectionsPanel
      report={null}
      loading={false}
      error={null}
      onRefresh={vi.fn()}
      onInstall={vi.fn()}
      {...props}
    />
  );
}

describe("Connections — every state a consumer can land in", () => {
  it("says it is reading rather than showing an empty section", () => {
    panel({ loading: true });
    expect(
      screen.getByText("Reading each agent CLI's own MCP config…")
    ).toBeTruthy();
  });

  it("says 'not checked yet' when nothing has been read and nothing is loading", () => {
    panel({});
    expect(screen.getByText("Not checked yet.")).toBeTruthy();
  });

  it("shows the failure AND keeps a live way forward", () => {
    const onRefresh = vi.fn();
    panel({ error: "The MCP status read failed: EPERM", onRefresh });
    expect(screen.getByText("The MCP status read failed: EPERM")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("renders an empty vendor list as a sentence, never as a blank card", () => {
    panel({ report: { ...report(), vendors: [] } });
    expect(
      screen.getByText("No agent CLI on this build can hold MUON's MCP server.")
    ).toBeTruthy();
  });
});

describe("Connections — the fields §5 requires, read from the shared report", () => {
  it("shows installed / not installed, the config path and commandResolves", () => {
    const built = report();
    panel({ report: built });
    for (const row of built.vendors) {
      expect(screen.getByText(row.label)).toBeTruthy();
      // The config path is the one the SHARED evaluator resolved, printed.
      expect(screen.getByText(row.configPath)).toBeTruthy();
    }
    expect(screen.getAllByText("Not registered")).toHaveLength(4);
    // Nothing registered ⇒ nothing to re-verify; "n/a" is the honest word.
    expect(screen.getAllByText("n/a")).toHaveLength(4);
  });

  it("names a recorded command that stopped resolving, in red, per D-cmd", () => {
    const home = tempDir("muon-desktop-mcp-home-");
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { muon: { command: "/Applications/MUON.app/old/muon-mcp" } },
      })
    );
    const built = report({
      roots: {
        home,
        configHome: path.join(home, ".config"),
        cwd: path.join(home, "repo"),
        redirectVendorConfigDirs: true,
      },
    });
    const claude = built.vendors[0]!;
    expect(claude.installed).toBe(true);
    expect(claude.commandResolves).toBe(false);
    panel({ report: built });
    // F8: the drift assessor upgrades the bare state word — a registered row
    // whose command stopped resolving reads as a broken path, not "Registered".
    expect(screen.getByText("Registered · broken path")).toBeTruthy();
    expect(
      screen.getByText("no — the recorded path no longer exists")
    ).toBeTruthy();
    // And the vendor's own reason, verbatim from the shared evaluator.
    const moved = claude.reasons.find((r) => r.id === "command-path-moved")!;
    expect(screen.getByText(moved.detail)).toBeTruthy();
  });

  it("summarises the tier, the credential branch and the brain state", () => {
    const built = report();
    panel({ report: built });
    const summary = document.querySelector(".mcp-summary")!.textContent ?? "";
    expect(summary).toContain(built.tier);
    expect(summary).toContain(built.tokenSource);
    expect(summary).toContain(`${built.toolCount} tools`);
    expect(summary).toContain("not running");
  });
});

describe("Connections — installable and coordinatorSeat are BOTH shown", () => {
  it("prints both booleans for all four vendors, never one alone", () => {
    // §2.2: conflating "MUON can install into it" with "it can coordinate a
    // crew" is the documentation failure ADR-0022 warns about. Cursor and
    // opencode are installable AND seatless, which is the pair a surface that
    // showed only `installable` would misrepresent.
    const built = report();
    panel({ report: built });
    expect(screen.getAllByText("Installable")).toHaveLength(4);
    expect(screen.getAllByText("Coordinator seat")).toHaveLength(4);

    const seatless = built.vendors.filter((row) => !row.coordinatorSeat);
    expect(seatless.map((row) => row.vendor)).toEqual(["cursor", "opencode"]);
    for (const row of built.vendors) {
      expect(row.installable).toBe(true);
    }
    // Testing Library normalizes the leading space off these spans.
    expect(
      screen.getAllByText(
        "— it can use MUON's memory + code graph, never coordinate a crew"
      )
    ).toHaveLength(seatless.length);
    expect(
      screen.getAllByText("— it can be the superagent that dispatches a crew")
    ).toHaveLength(built.vendors.length - seatless.length);
  });
});

describe("Connections — parity with the shared evaluator", () => {
  it("PRINTS the report's own fields, and never re-derives them", () => {
    // THE MUTATION THIS TEST EXISTS FOR. The first version of the assertions
    // above compared the rendered row against a report whose fields all agreed
    // with each other, so a row that recomputed `installed` from `command`
    // still passed. It survived a real restatement mutation — exactly the
    // cross-surface drift §5 is written to prevent.
    //
    // So: hand the panel a report whose fields deliberately DISAGREE, in the
    // direction only the shared evaluator can decide. A row that reads
    // `row.installed` prints "Registered"; a row that derives it from the
    // presence of a command prints "Not registered" and fails here.
    const base = report();
    for (const row of base.vendors) {
      expect(row.installed).toBe(false);
      expect(row.command).toBeNull();
    }
    panel({
      report: {
        ...base,
        tier: "none",
        tokenSource: "lockfile.agentToken",
        toolCount: 999,
        vendors: base.vendors.map((row) => ({
          ...row,
          installed: true,
          commandResolves: true,
          installable: true,
          coordinatorSeat: !row.coordinatorSeat,
        })),
      },
    });

    // F8: rows read installed:true + commandResolves:true; with the report's
    // resolvedCommand differing per fixture the assessor may say in-sync or
    // drifted — both begin "Registered ·", which is the point being pinned:
    // the STATE derives from row.installed, never from command presence.
    expect(screen.getAllByText(/^Registered · /)).toHaveLength(4);
    expect(screen.getAllByText("yes").length).toBeGreaterThan(0);
    expect(screen.queryByText("n/a")).toBeNull();
    const summary = document.querySelector(".mcp-summary")!.textContent ?? "";
    expect(summary).toContain("none");
    expect(summary).toContain("lockfile.agentToken");
    expect(summary).toContain("999 tools");
    // The seat booleans followed the ROW, not the vendor registry: claude-code
    // and codex really hold the seat, and here they must read as if they do not.
    expect(
      screen.getAllByText(
        "— it can use MUON's memory + code graph, never coordinate a crew"
      )
    ).toHaveLength(2);
  });
});

describe("Connections — Install never leads into a dead end", () => {
  it("registers through the bridge and reports what was written", async () => {
    const built = report();
    const onRefresh = vi.fn();
    const onInstall = vi.fn(
      async (): Promise<McpInstallReport> => ({
        vendor: "claude-code",
        scope: "user",
        command: MCP_BIN,
        outcome: {
          kind: "written",
          configPath: "/tmp/muon-desktop-mcp/.claude.json",
          entry: "{}",
          via: "claude mcp add muon -s user -- /opt/muon/bin/muon-mcp",
          replaced: false,
          followUps: [],
        },
      })
    );
    panel({ report: built, onInstall, onRefresh });

    fireEvent.click(screen.getAllByRole("button", { name: "Install" })[0]!);
    await waitFor(() => expect(onInstall).toHaveBeenCalledWith("claude-code"));
    // The write is reported with the file, AND with what was deliberately NOT
    // written — a user must be able to see MUON custodied no credential.
    expect(
      await screen.findByText(/No token, no API base and no mode were written/)
    ).toBeTruthy();
    // The status is re-read so the row stops claiming "Not registered".
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("disables Install AND says why when the vendor CLI is absent", () => {
    const built = report({ which: () => null, isExecutableFile: () => false });
    panel({ report: built });
    for (const button of screen.getAllByRole("button", { name: "Install" })) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
    // A disabled control with no sentence beside it IS the dead end.
    expect(
      screen.getByText(
        "claude is not on this machine. MUON never installs or signs you in to an agent CLI — install it yourself, then re-check."
      )
    ).toBeTruthy();
  });

  it("disables Install AND says why when no muon-mcp resolves (the .dmg case)", () => {
    // `which` still finds the vendor CLIs, but nothing is an executable file,
    // so `resolveMuonMcpCommand` refuses — §1.4c.
    const built = report({ isExecutableFile: () => false });
    expect(built.resolvedCommand).toBeNull();
    panel({ report: built });
    for (const button of screen.getAllByRole("button", { name: "Install" })) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
    expect(
      screen.getAllByText(
        "No executable 'muon-mcp' resolved on this machine, so MUON has no verified path to record."
      ).length
    ).toBe(built.vendors.length);
  });

  it("turns a rejected bridge call into a sentence, not a stuck button", async () => {
    const built = report();
    const onInstall = vi.fn().mockRejectedValue(new Error("bridge is down"));
    panel({ report: built, onInstall });
    const button = screen.getAllByRole("button", { name: "Install" })[0]!;
    fireEvent.click(button);
    expect(await screen.findByText("bridge is down")).toBeTruthy();
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("shows a refusal verbatim rather than pretending the write landed", async () => {
    const built = report();
    const onInstall = vi.fn(
      async (): Promise<McpInstallReport> => ({
        vendor: "claude-code",
        scope: "user",
        command: null,
        outcome: {
          kind: "refused",
          reason: "Could not find an executable 'muon-mcp' to register.",
        },
      })
    );
    panel({ report: built, onInstall });
    fireEvent.click(screen.getAllByRole("button", { name: "Install" })[0]!);
    expect(
      await screen.findByText(
        "Could not find an executable 'muon-mcp' to register."
      )
    ).toBeTruthy();
  });
});

describe("Connections — ADR-0028 Tier C attach/detach", () => {
  it("shows the attach row only for coordinator-seat vendors, and only Attach when nothing is attached", () => {
    const built = report();
    panel({ report: built, onAttach: vi.fn(), onDetach: vi.fn() });
    // Two coordinator-seat vendors (claude-code, codex) get the row; cursor
    // and opencode — seatless — must not.
    expect(screen.getAllByText("Not attached")).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Attach" })
    ).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Detach" })).toBeNull();
  });

  it("omits the attach row entirely when no attach handler is wired", () => {
    // An older caller (or a build that has not wired the bridge) must still
    // mount cleanly — the point of the whole trio being optional.
    panel({ report: report() });
    expect(screen.queryByText("Not attached")).toBeNull();
    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
  });

  it("attaches through the bridge and shows the outcome, never the token", async () => {
    const built = report();
    const onAttach = vi.fn(async () => ({
      kind: "attached" as const,
      vendor: "codex" as const,
      jobId: "job-1",
      chatId: "chat-1",
      workspacePath: "/repo",
      expiresAt: "2026-08-02T00:05:00.000Z",
      attestation: { posture: "non-hermetic", claim: "external, human-started session" },
    }));
    panel({ report: built, onAttach, onDetach: vi.fn() });

    const codexRow = screen.getByText("Codex").closest(".mcp-row")!;
    fireEvent.click(
      Array.from(codexRow.querySelectorAll("button")).find(
        (b) => b.textContent === "Attach"
      )!
    );
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith("codex"));
    expect(
      await screen.findByText(/restart codex to pick up the new MCP entry/)
    ).toBeTruthy();
    // The success payload never carries a token field to begin with, and
    // nothing in the rendered row does either.
    const result = await onAttach.mock.results[0]!.value;
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("shows 'Attached' + Detach when the vendor's root job is already attached", () => {
    const built = report();
    panel({
      report: built,
      onAttach: vi.fn(),
      onDetach: vi.fn(),
      attachedByVendor: new Map([
        ["codex", { jobId: "job-1", chatId: "chat-1" }],
      ]),
    });
    expect(screen.getByText("Attached coordinator (non-hermetic)")).toBeTruthy();
    // codex is attached; claude-code (the other coordinator-seat vendor) is not.
    expect(screen.getByText("Not attached")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Detach" })
    ).toBeTruthy();
  });

  it("detaches through the bridge and shows the outcome", async () => {
    const built = report();
    const onDetach = vi.fn(async () => ({
      kind: "detached" as const,
      jobId: "job-1",
      notes: [],
    }));
    panel({
      report: built,
      onAttach: vi.fn(),
      onDetach,
      attachedByVendor: new Map([
        ["codex", { jobId: "job-1", chatId: "chat-1" }],
      ]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(onDetach).toHaveBeenCalledWith("codex"));
    expect(
      await screen.findByText(/Detached and reverted codex's MCP config to base/)
    ).toBeTruthy();
  });

  it("shows an incomplete detach as a failure sentence with the cleanup reason", async () => {
    const built = report();
    const onDetach = vi.fn(async () => ({
      kind: "partial" as const,
      jobId: "job-1",
      notes: ["backend detach: brain unreachable"],
    }));
    panel({
      report: built,
      onAttach: vi.fn(),
      onDetach,
      attachedByVendor: new Map([
        ["codex", { jobId: "job-1", chatId: "chat-1" }],
      ]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(
      await screen.findByText(/Detach incomplete:.*brain unreachable/)
    ).toBeTruthy();
  });

  it("turns a rejected attach call into a sentence, not a stuck button", async () => {
    const built = report();
    const onAttach = vi.fn().mockRejectedValue(new Error("brain unreachable"));
    panel({ report: built, onAttach, onDetach: vi.fn() });
    const button = screen.getAllByRole("button", { name: "Attach" })[0]!;
    fireEvent.click(button);
    expect(await screen.findByText("brain unreachable")).toBeTruthy();
    expect(button.hasAttribute("disabled")).toBe(false);
  });
});
