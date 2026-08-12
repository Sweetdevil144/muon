// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "../src/renderer/workspace-tabs.js";
import type { SubagentTab } from "../src/lib/subagent-tabs.js";
import { agentCodename } from "../src/lib/agent-codename.js";

afterEach(cleanup);

function tab(overrides: Partial<SubagentTab> = {}): SubagentTab {
  return {
    jobId: "job-1",
    agentId: "agent-1",
    vendor: "codex",
    status: "running",
    pendingCloseAt: null,
    pinned: false,
    ...overrides,
  };
}

describe("WorkspaceTabs", () => {
  it("uses valid tab semantics, separate close buttons, and keyboard navigation", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      React.createElement(WorkspaceTabs, {
        activeId: "job-1",
        panelTabs: [],
        tabs: [
          tab({ jobId: "job-1", agentId: "agent-1", vendor: "codex", status: "running" }),
          tab({ jobId: "job-2", agentId: "agent-2", vendor: "claude-code", status: "queued" }),
        ],
        onSelect,
        onClose,
      })
    );

    // The tab's accessible name is now "<Codename> · <Vendor> <status>" — the
    // vendor stays visible, so /codex working/i still selects the codex tab.
    const codexTab = screen.getByRole("tab", { name: /codex working/i });
    expect(codexTab.getAttribute("aria-controls")).toBe("workspace-panel-job-1");
    expect(codexTab.querySelector("button")).toBeNull();
    fireEvent.keyDown(codexTab, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("job-2");
    fireEvent.click(
      screen.getByRole("button", { name: `Close ${agentCodename("agent-1")} tab` })
    );
    expect(onClose).toHaveBeenCalledWith("job-1");
  });

  it("always renders 'Mission chat' first, selectable and never closable", () => {
    render(
      React.createElement(WorkspaceTabs, {
        activeId: "chat",
        panelTabs: [],
        tabs: [tab()],
        onSelect: vi.fn(),
        onClose: vi.fn(),
      })
    );
    const missionTab = screen.getByRole("tab", { name: "Mission chat" });
    expect(missionTab.getAttribute("aria-selected")).toBe("true");
    // Only one close button exists — for the subagent tab, not the mission chat.
    expect(screen.getAllByRole("button", { name: /^Close .* tab$/ })).toHaveLength(1);
  });

  // Terminal-native — the vendor tab bar IS the terminal entry point: one
  // click per vendor opens that vendor's real interactive CLI as a tab.
  describe("vendor tab bar + human terminal tabs", () => {
    const MENU = [
      { kind: "claude-code", label: "Claude", enabled: true, detail: null },
      { kind: "codex", label: "Codex", enabled: true, detail: null },
      {
        kind: "cursor",
        label: "Cursor",
        enabled: false,
        detail: "The Cursor CLI is not installed, so MUON cannot open it here.",
      },
      { kind: "shell", label: "Terminal", enabled: true, detail: null },
    ];

    // The bar is now ONE "+" trigger; every spawnable entry lives in its menu.
    it("collapses spawning to a single '+' trigger whose menu names every KIND", () => {
      const onOpenVendorTerminal = vi.fn();
      render(
        React.createElement(WorkspaceTabs, {
          activeId: "chat",
          panelTabs: [],
          tabs: [],
          onSelect: vi.fn(),
          onClose: vi.fn(),
          vendorMenu: MENU,
          onOpenVendorTerminal,
        })
      );

      const trigger = screen.getByRole("button", {
        name: "Open a terminal in this workspace",
      });
      // Closed by default: no per-vendor buttons on the strip itself.
      expect(screen.queryByRole("menu")).toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(trigger);
      const menu = screen.getByRole("menu", {
        name: "Open a terminal in this workspace",
      });
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.getAttribute("aria-label"))
      ).toEqual([
        "New Claude session",
        "New Codex session",
        "New Cursor session",
        "New Terminal tab",
      ]);

      fireEvent.click(
        screen.getByRole("menuitem", { name: "New Claude session" })
      );
      expect(onOpenVendorTerminal).toHaveBeenCalledWith("claude-code");
      // Selection closes the menu; reopen for the shell entry.
      expect(screen.queryByRole("menu")).toBeNull();
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("menuitem", { name: "New Terminal tab" }));
      expect(onOpenVendorTerminal).toHaveBeenCalledWith("shell");
    });

    it("closes the menu on Escape without spawning", () => {
      const onOpenVendorTerminal = vi.fn();
      render(
        React.createElement(WorkspaceTabs, {
          activeId: "chat",
          panelTabs: [],
          tabs: [],
          onSelect: vi.fn(),
          onClose: vi.fn(),
          vendorMenu: MENU,
          onOpenVendorTerminal,
        })
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Open a terminal in this workspace" })
      );
      expect(screen.getByRole("menu")).toBeTruthy();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(onOpenVendorTerminal).not.toHaveBeenCalled();
    });

    it("disables — never hides — a vendor whose CLI is not installed, with the reason visible", () => {
      const onOpenVendorTerminal = vi.fn();
      render(
        React.createElement(WorkspaceTabs, {
          activeId: "chat",
          panelTabs: [],
          tabs: [],
          onSelect: vi.fn(),
          onClose: vi.fn(),
          vendorMenu: MENU,
          onOpenVendorTerminal,
        })
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Open a terminal in this workspace" })
      );
      const cursor = screen.getByRole("menuitem", {
        name: "New Cursor session",
      });
      // `aria-disabled` (not `disabled`) — the entry stays focusable so the
      // reason is reachable, and it renders inline, not hover-only.
      expect(cursor.getAttribute("aria-disabled")).toBe("true");
      expect(cursor.textContent).toMatch(/not installed/);
      fireEvent.click(cursor);
      expect(onOpenVendorTerminal).not.toHaveBeenCalled();
      // A no-op click keeps the menu open — nothing happened.
      expect(screen.getByRole("menu")).toBeTruthy();
    });

    it("renders human terminal tabs as selectable, closable, keyboard-reachable tabs", () => {
      const onSelect = vi.fn();
      const onClose = vi.fn();
      render(
        React.createElement(WorkspaceTabs, {
          activeId: "terminal-chat:chat-1:claude-code.1",
          panelTabs: [],
          tabs: [],
          onSelect,
          onClose,
          terminalTabs: [
            {
              id: "terminal-chat:chat-1:claude-code.1",
              label: "Claude",
              kind: "claude-code",
            },
            {
              id: "terminal-chat:chat-1:claude-code.2",
              label: "Claude 2",
              kind: "claude-code",
            },
          ],
          vendorMenu: MENU,
          onOpenVendorTerminal: vi.fn(),
        })
      );

      const first = screen.getByRole("tab", { name: "Claude" });
      expect(first.getAttribute("aria-selected")).toBe("true");
      // The second session of the same vendor is its own numbered tab.
      fireEvent.click(screen.getByRole("tab", { name: "Claude 2" }));
      expect(onSelect).toHaveBeenCalledWith(
        "terminal-chat:chat-1:claude-code.2"
      );
      // Arrow navigation includes terminal tabs.
      fireEvent.keyDown(first, { key: "ArrowRight" });
      expect(onSelect).toHaveBeenCalledWith(
        "terminal-chat:chat-1:claude-code.2"
      );
      // Closing goes through onClose with the SESSION id (the pty dies).
      fireEvent.click(
        screen.getByRole("button", { name: "Close Claude 2 tab" })
      );
      expect(onClose).toHaveBeenCalledWith(
        "terminal-chat:chat-1:claude-code.2"
      );
    });

    // ROADMAP T2 — human terminal tabs get the SAME activity-dot vocabulary
    // as subagent tabs, but `status` is optional so a caller with no
    // activity tracker wired up (the test above) keeps its plain tab.
    it("renders an activity dot on a human terminal tab when a status is supplied", () => {
      const { container } = render(
        React.createElement(WorkspaceTabs, {
          activeId: "term-1",
          panelTabs: [],
          tabs: [],
          onSelect: vi.fn(),
          onClose: vi.fn(),
          terminalTabs: [
            { id: "term-1", label: "Claude", kind: "claude-code", status: "working" },
            { id: "term-2", label: "Terminal", kind: "shell", status: "permission" },
          ],
        })
      );

      const working = screen.getByRole("tab", { name: "Claude · working" });
      expect(working.querySelector(".activity-dot.working")).not.toBeNull();

      const permission = screen.getByRole("tab", {
        name: "Terminal · permission",
      });
      expect(
        permission.querySelector(".activity-dot.permission")
      ).not.toBeNull();

      // The pre-T2 shape (no status) still renders no dot at all.
      expect(
        container.querySelectorAll(".workspace-terminal-tab .activity-dot")
      ).toHaveLength(2);
    });
  });

  it("gives same-vendor tabs distinct display codenames (vendor stays visible)", () => {
    render(
      React.createElement(WorkspaceTabs, {
        activeId: "chat",
        panelTabs: [],
        tabs: [
          tab({ jobId: "job-1", agentId: "agent-1", vendor: "codex" }),
          tab({ jobId: "job-2", agentId: "agent-2", vendor: "codex" }),
        ],
        onSelect: vi.fn(),
        onClose: vi.fn(),
      })
    );
    const first = agentCodename("agent-1");
    const second = agentCodename("agent-2");
    // Distinct agents ⇒ distinct codenames (no "#2" ordinal any more), each
    // with its vendor + status kept in the accessible name.
    expect(first).not.toBe(second);
    expect(
      screen.getByRole("tab", { name: `${first} · Codex working` })
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: `${second} · Codex working` })
    ).toBeTruthy();
  });

  it("dims a 'done' tab (pendingCloseAt set) but never a failed one", () => {
    const { container } = render(
      React.createElement(WorkspaceTabs, {
        activeId: "chat",
        panelTabs: [],
        tabs: [
          tab({ jobId: "job-1", status: "done", pendingCloseAt: 1000 }),
          tab({ jobId: "job-2", status: "failed", pendingCloseAt: null }),
        ],
        onSelect: vi.fn(),
        onClose: vi.fn(),
      })
    );
    const tabs = container.querySelectorAll(".workspace-agent-tab");
    expect(tabs[0]?.className).toContain("tab-closing");
    expect(tabs[1]?.className).not.toContain("tab-closing");
  });

  // Task #130 — Memory & Evidence workspace tabs.
  describe("panelTabs (Memory/Evidence, task #130)", () => {
    it("renders panel tabs AFTER 'Mission chat' and BEFORE the jobId tabs, with a plain label + close, no status dot", () => {
      const onSelect = vi.fn();
      const onClose = vi.fn();
      render(
        React.createElement(WorkspaceTabs, {
          activeId: "panel:evidence",
          panelTabs: [
            { id: "panel:memory", label: "Memory" },
            { id: "panel:evidence", label: "Evidence" },
          ],
          tabs: [tab({ jobId: "job-1", vendor: "codex" })],
          onSelect,
          onClose,
        })
      );

      const tablist = screen.getByRole("tablist", {
        name: "Open workspace tabs",
      });
      const tabButtons = within(tablist).getAllByRole("tab");
      expect(tabButtons.map((button) => button.textContent)).toEqual([
        "Mission chat",
        "Memory",
        "Evidence",
        expect.stringContaining("Codex"),
      ]);

      const evidenceTab = screen.getByRole("tab", { name: "Evidence" });
      expect(evidenceTab.getAttribute("aria-selected")).toBe("true");
      expect(evidenceTab.getAttribute("aria-controls")).toBe(
        "workspace-panel-panel:evidence"
      );
      // No status dot / vendor status text on a panel tab.
      expect(evidenceTab.querySelector(".activity-dot")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Close Memory tab" }));
      expect(onClose).toHaveBeenCalledWith("panel:memory");

      fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
      expect(onSelect).toHaveBeenCalledWith("panel:memory");
    });

    it("includes panel tab ids in keyboard arrow-navigation", () => {
      const onSelect = vi.fn();
      render(
        React.createElement(WorkspaceTabs, {
          activeId: "chat",
          panelTabs: [{ id: "panel:memory", label: "Memory" }],
          tabs: [],
          onSelect,
          onClose: vi.fn(),
        })
      );
      fireEvent.keyDown(screen.getByRole("tab", { name: "Mission chat" }), {
        key: "ArrowRight",
      });
      expect(onSelect).toHaveBeenCalledWith("panel:memory");
    });
  });
});
