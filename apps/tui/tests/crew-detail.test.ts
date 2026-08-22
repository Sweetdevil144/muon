import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { CrewDetailPane } from "../src/shell/crew-detail-pane.js";
import type { CrewPanelLoad } from "../src/lib/crew-view.js";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";

// ── ADR-0087 M7 — the crew detail carries the shared view's honesty bars ────

const strip = (lines: string[]) =>
  lines.map((line) => line.replaceAll(/\[[0-9;]*m/g, "")).join("\n");

function load(over: Partial<CrewPanelLoad> = {}): CrewPanelLoad {
  return {
    chatId: "chat-1",
    roles: {
      status: "ready",
      planStatus: "proposed",
      rows: [
        {
          role: "implementer",
          vendor: "codex",
          authority: "write",
          fit: "0.82",
          assignedBy: "muon",
          blocked: false,
          reason: "strongest recent implementer",
        },
        {
          role: "reviewer",
          vendor: "claude-code",
          authority: "read-only",
          fit: "0.91",
          assignedBy: "human",
          blocked: true,
          blockedReason: "lane not ready",
          reason: "pinned",
        },
      ],
      unfilled: ["security"],
      lanes: [{ vendor: "codex", health: "ready", displayName: "Codex" }],
    },
    coordination: {
      status: "ready",
      missionId: "cmb4mission0001abcdefghij",
      participants: [
        {
          jobId: "cmb4worker0001abcdefghijk",
          role: "implementer",
          vendor: "codex",
          status: "running",
          claimedPaths: 2,
          unreadMessages: 1,
        },
      ],
      conflicts: [
        {
          path: "src/auth.ts",
          heldBy: "implementer",
          jobId: "cmb4worker0001abcdefghijk",
          expiresAt: "2026-08-22T12:00:00Z",
        },
      ],
      messages: [
        {
          id: "m1",
          kind: "finding",
          from: "implementer",
          to: "crew",
          subject: "auth module refactored",
          body: "b",
          refs: [],
          citations: ["mem-x — cited, never offered — relay"],
          finding: "mem-published-finding",
        },
      ],
      messageCount: 7,
    },
    ...over,
  } as CrewPanelLoad;
}

describe("the crew detail pane", () => {
  it("renders the planStatus DISTINCTION, blocked roles, unfilled, and the untrusted-traffic framing with honest counts", () => {
    const text = strip(
      new CrewDetailPane({ phase: "ready", load: load() }).render(240)
    );
    // A preview never reads as a commitment.
    expect(text).toContain("proposed — a preview, nobody has committed this crew");
    expect(text).toContain("implementer");
    expect(text).toContain("write · fit 0.82 · by muon");
    expect(text).toContain("lane not ready");
    expect(text).toContain("unfilled: security");
    // Coordination: claims, unread, contested paths.
    expect(text).toContain("2 claim(s) · 1 unread");
    expect(text).toContain("src/auth.ts");
    // Peer traffic is UNTRUSTED and the page is honest about its window.
    expect(text).toContain("UNTRUSTED agent-authored text");
    expect(text).toContain("showing 1 of 7 message(s)");
  });

  it("an assigned plan reads as assigned; unavailability is a stated sentence", () => {
    const assigned = strip(
      new CrewDetailPane({
        phase: "ready",
        load: load({
          roles: { ...load().roles, planStatus: "assigned" } as never,
        }),
      }).render(240)
    );
    expect(assigned).toContain("assigned");
    expect(assigned).not.toContain("preview");
    const missing = strip(
      new CrewDetailPane({
        phase: "unavailable",
        reason: "no active chat for this workspace yet — a mission creates one",
      }).render(240)
    );
    expect(missing).toContain("no active chat");
  });
});

describe("the desk flow", () => {
  const PREFIX = String.fromCodePoint(2);
  function makeDesk(loadCrewDetail?: () => Promise<CrewPanelLoad | null>) {
    const snapshot = emptyBrainSnapshot();
    const desk = new Desk({
      client: {} as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 80, rows: 12 }),
      terminalRows: () => 30,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
      ...(loadCrewDetail ? { loadCrewDetail } : {}),
    });
    return desk;
  }

  it("d on the crew drawer opens the detail through the injected shared loader", async () => {
    const loader = vi.fn(async () => load());
    const desk = makeDesk(loader);
    desk.handleKey(PREFIX);
    desk.handleKey("c"); // crew drawer
    expect(desk.centreKind()).toBe("crew");
    desk.handleKey("d");
    expect(desk.centreKind()).toBe("crew-detail");
    await vi.waitFor(() => expect(loader).toHaveBeenCalled());
    desk.handleKey(esc());
    // Esc pops the detail; the drawer is still underneath.
    expect(desk.centreKind()).toBe("crew");
  });

  it("a chat-less workspace states it; an unwired build names the CLI", async () => {
    const desk = makeDesk(vi.fn(async () => null));
    desk.handleKey(PREFIX);
    desk.handleKey("c");
    desk.handleKey("d");
    await vi.waitFor(() =>
      expect(desk.centreKind()).toBe("crew-detail")
    );
    const unwired = makeDesk();
    unwired.handleKey(PREFIX);
    unwired.handleKey("c");
    unwired.handleKey("d");
    expect(unwired.centreKind()).toBe("crew"); // stayed on the drawer
  });
});

function esc(): string {
  return String.fromCodePoint(0x1b);
}
