import { describe, expect, it } from "vitest";
import {
  foldPaneStatuses,
  paneStatusPriority,
  resolvePaneDisplayStatus,
  resolveTerminalPaneStatus,
  TERMINAL_IDLE_TIMEOUT_MS,
  type TerminalActivitySnapshot,
} from "../src/lib/pane-status.js";

describe("pane-status (TODO 3.15)", () => {
  it("orders idle < review < working < failed < permission", () => {
    expect(paneStatusPriority("idle")).toBeLessThan(paneStatusPriority("review"));
    expect(paneStatusPriority("review")).toBeLessThan(paneStatusPriority("working"));
    expect(paneStatusPriority("working")).toBeLessThan(paneStatusPriority("failed"));
    expect(paneStatusPriority("failed")).toBeLessThan(paneStatusPriority("permission"));
  });

  it("folds to the highest-priority status", () => {
    expect(foldPaneStatuses(["idle", "review", "working"])).toBe("working");
    expect(foldPaneStatuses(["failed", "permission"])).toBe("permission");
  });

  it("maps done+unseen to review and done+seen to idle", () => {
    expect(
      resolvePaneDisplayStatus({ jobStatus: "done", seen: false, pendingApproval: false })
    ).toBe("review");
    expect(
      resolvePaneDisplayStatus({ jobStatus: "done", seen: true, pendingApproval: false })
    ).toBe("idle");
  });

  it("never seen-gates permission", () => {
    expect(
      resolvePaneDisplayStatus({ jobStatus: "done", seen: true, pendingApproval: true })
    ).toBe("permission");
  });
});

describe("resolveTerminalPaneStatus (ROADMAP T2)", () => {
  const NOW = 1_000_000;
  function snapshot(
    overrides: Partial<TerminalActivitySnapshot> = {}
  ): TerminalActivitySnapshot {
    return {
      lastActivityAt: null,
      exitCode: null,
      seen: false,
      permissionPromptDetected: false,
      ...overrides,
    };
  }

  it("reads recent output/input as working", () => {
    expect(
      resolveTerminalPaneStatus(
        snapshot({ lastActivityAt: NOW - 100 }),
        NOW
      )
    ).toBe("working");
  });

  it("falls back to idle once the activity timeout has elapsed", () => {
    expect(
      resolveTerminalPaneStatus(
        snapshot({ lastActivityAt: NOW - TERMINAL_IDLE_TIMEOUT_MS - 1 }),
        NOW
      )
    ).toBe("idle");
  });

  it("is idle before anything has ever happened on the tab", () => {
    expect(resolveTerminalPaneStatus(snapshot(), NOW)).toBe("idle");
  });

  it("surfaces a heuristic permission-prompt match, even over recent activity", () => {
    expect(
      resolveTerminalPaneStatus(
        snapshot({
          lastActivityAt: NOW - 100,
          permissionPromptDetected: true,
        }),
        NOW
      )
    ).toBe("permission");
  });

  it("a non-zero exit is ALWAYS failed, never seen-gated", () => {
    expect(
      resolveTerminalPaneStatus(snapshot({ exitCode: 1, seen: true }), NOW)
    ).toBe("failed");
    expect(
      resolveTerminalPaneStatus(snapshot({ exitCode: 1, seen: false }), NOW)
    ).toBe("failed");
  });

  it("a clean exit is review until seen, then idle", () => {
    expect(
      resolveTerminalPaneStatus(snapshot({ exitCode: 0, seen: false }), NOW)
    ).toBe("review");
    expect(
      resolveTerminalPaneStatus(snapshot({ exitCode: 0, seen: true }), NOW)
    ).toBe("idle");
  });

  it("an exit outranks a stale permission match — the session is gone either way", () => {
    expect(
      resolveTerminalPaneStatus(
        snapshot({ exitCode: 0, seen: false, permissionPromptDetected: true }),
        NOW
      )
    ).toBe("review");
  });
});
