// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrewPanel, Sidebar } from "../src/renderer/sidebar.js";
import type { DesktopState } from "../src/shared/ipc.js";

// Pins the scroll contracts the Crew screenshot failed: the session rail
// clipped instead of scrolling, and the Crew page clipped the fleet because
// `.crew-workspace` used height:100% without the flex min-height:0 shell
// Settings/Control already had.

const source = readFileSync("src/renderer/styles.css", "utf8");

function ruleBody(text: string, selectorText: string): string {
  const at = text.indexOf(selectorText);
  expect(at, `selector not found: ${selectorText}`).toBeGreaterThanOrEqual(0);
  const braceStart = text.indexOf("{", at);
  const braceEnd = text.indexOf("}", braceStart);
  return text.slice(braceStart + 1, braceEnd);
}

afterEach(cleanup);

const emptyState = {
  chats: [],
  fleet: { counts: {}, agents: [] },
} as unknown as DesktopState;

describe("sidebar scrollports", () => {
  it("the frame fills #root, not 100vh, so body overflow cannot clip the rail", () => {
    const body = ruleBody(source, ".app {");
    expect(body).toContain("height: 100%;");
    expect(body).toContain("max-height: 100%;");
    expect(body).toContain("overflow: hidden;");
    expect(body).not.toMatch(/height:\s*100vh/);
  });

  it("chrome and session list are each overflow-y: auto flex children of a clipped sidebar", () => {
    const sidebarBlock = source.slice(
      source.indexOf("/* ---- sidebar: crew index ---- */")
    );
    const sidebar = ruleBody(sidebarBlock, ".sidebar {");
    expect(sidebar).toContain("overflow: hidden;");
    expect(sidebar).toContain("min-height: 0;");

    const chrome = ruleBody(source, ".sidebar-chrome {");
    expect(chrome).toContain("overflow-y: auto;");
    expect(chrome).toContain("min-height: 0;");

    const inChromeNav = ruleBody(source, ".sidebar-chrome > .left-nav {");
    expect(inChromeNav).toContain("flex: 0 0 auto;");
    expect(inChromeNav).toContain("overflow: visible;");

    const scroll = ruleBody(source, ".sidebar-scroll {");
    expect(scroll).toContain("overflow-y: auto;");
    expect(scroll).toContain("flex: 1 1 0%;");
    expect(scroll).toContain("min-height: 8rem;");
  });

  it("keeps nav + auto-approve in chrome and sessions in the scroller", () => {
    const { container } = render(
      React.createElement(Sidebar, {
        state: emptyState,
        activeChatId: null,
        taskTitles: new Map(),
        onSelectChat: vi.fn(),
        onArchiveChat: vi.fn(),
        navActive: "crew",
        navPendingDecisions: 0,
        navCrewActive: false,
        navFleet: [],
        onNavigate: vi.fn(),
        onNewChat: vi.fn(),
        onStepFleet: vi.fn(),
        onOpenAgent: vi.fn(),
        onSetFullAutoVendors: vi.fn(),
      })
    );
    const chrome = container.querySelector(".sidebar-chrome");
    const scroll = container.querySelector(".sidebar-scroll");
    expect(chrome).toBeTruthy();
    expect(scroll).toBeTruthy();
    expect(chrome?.querySelector(".left-nav")).toBeTruthy();
    expect(chrome?.querySelector(".full-auto-section")).toBeTruthy();
    expect(chrome?.textContent).toMatch(/Timeline/);
    expect(chrome?.textContent).toMatch(/Graph/);
    expect(scroll?.querySelector(".full-auto-section")).toBeNull();
    expect(scroll?.querySelector(".left-nav")).toBeNull();
    expect(scroll?.textContent).toMatch(/No sessions yet/);
  });
});

describe("Crew workspace scroll + layout", () => {
  it("fills the panel shell and scrolls like Settings/Control", () => {
    const body = ruleBody(source, ".crew-workspace {");
    expect(body).toContain("flex: 1;");
    expect(body).toContain("min-height: 0;");
    expect(body).toMatch(/overflow:\s*auto;/);
    expect(
      ruleBody(source, ".workspace-panel-shell > .crew-workspace {")
    ).toContain("min-height: 0;");
  });

  it("places cost meter and cap on one crew-meter-grid", () => {
    const { container } = render(
      React.createElement(CrewPanel, {
        state: emptyState,
        taskTitles: new Map(),
        onStepFleet: vi.fn(),
        onOpenAgent: vi.fn(),
        missionEvents: [],
        activeChatId: "chat-1",
      })
    );
    const grid = container.querySelector(".crew-meter-grid");
    expect(grid).toBeTruthy();
    expect(grid?.querySelector(".mission-usage")).toBeTruthy();
    // Cost cap is a sibling in the grid markup; it renders null without the
    // missionCost bridge, which this unit test does not install.
  });
});

// Extends the founder's Crew treatment to every tab (2026-08-20): one shared
// page-head pattern that Crew cannot drift from, the Memory tab on the same
// shell contract as Settings/Control/Crew, and Evidence opening with a name.
describe("the tab language is ONE language", () => {
  it("crew's head is the SHARED pattern, not a private copy", () => {
    // The shared block must name all three head classes…
    const shared = ruleBody(
      source,
      ".workspace-page-head,\n.crew-workspace-head,\n.settings-workspace-head"
    );
    expect(shared).toContain("border-bottom");
    // …and no separate block may exist to diverge — neither the head nor the
    // nested title wrapper Crew uses to seat its freshness chip. The wrapper
    // keeps its LAYOUT rule; its TYPE comes from the shared contract.
    expect(source.match(/^\.crew-workspace-head \{/m)).toBeNull();
    expect(source.match(/^\.crew-workspace-title > strong \{/m)).toBeNull();
    const sharedStrong = ruleBody(
      source,
      ".workspace-page-head > strong,\n.crew-workspace-head > strong,\n.crew-workspace-title > strong,\n.settings-workspace-head > strong"
    );
    expect(sharedStrong).toContain("1.35rem");
  });

  it("memory has the same shell contract as the other tabs", () => {
    const body = ruleBody(source, ".memory-workspace {");
    for (const decl of ["overflow: auto", "max-width: 72rem", "margin-inline: auto", "min-height: 0"]) {
      expect(body, decl).toContain(decl);
    }
  });

  it("evidence opens with the shared page head", () => {
    const brain = readFileSync("src/renderer/brain.tsx", "utf8");
    const headAt = brain.indexOf('className="workspace-page-head"');
    const searchAt = brain.indexOf('className="brain-search"');
    expect(headAt).toBeGreaterThan(-1);
    expect(searchAt).toBeGreaterThan(-1);
    // The head comes BEFORE the search box — the page has a name first.
    expect(headAt).toBeLessThan(searchAt);
  });
});
