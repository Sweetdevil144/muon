// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/renderer/chat.js";

/**
 * The founder-reported defect: "super shit stop turn UI. should have been like
 * claude stop button only."
 *
 * A full-width amber slab ("Restored active mission turn · … [Stop this turn]")
 * sat ABOVE the conversation and read like an error. The turn control now lives
 * with the composer, where the send action is: one small live dot, what the
 * turn is doing, and a compact stop in the send slot.
 *
 * These tests pin the parts that are NOT presentation: the same governed stop
 * call fires, the running activity is still stated, and the composer stays
 * locked with its reason.
 */

const chat = {
  id: "chat-1",
  title: "Repair parser",
  workspacePath: "/repo",
};

function base(overrides: Record<string, unknown> = {}) {
  return {
    chat,
    approvals: [],
    running: false,
    live: [],
    onSend: vi.fn(),
    onResolveApproval: vi.fn(),
    onLiveSettled: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  Object.assign(window, {
    muon: { streams: vi.fn().mockResolvedValue([]) },
  });
});

afterEach(cleanup);

describe("the turn control lives with the composer", () => {
  it("shows stop, the live indicator, and the activity while a turn runs", () => {
    render(
      React.createElement(
        ChatView,
        base({
          running: true,
          turnActivity: "mcp__muon__peer_inbox",
          onStopTurn: vi.fn(),
        }) as never
      )
    );

    const stop = screen.getByRole("button", { name: "Stop this turn" });
    // It belongs to the composer, not to a banner over the conversation.
    expect(stop.closest(".composer")).not.toBeNull();
    expect(stop.closest(".composer-toolbar")).not.toBeNull();
    // The compact status row carries the pulse + what the turn is doing.
    const status = document.querySelector(".composer-turn");
    expect(status).not.toBeNull();
    expect(status?.querySelector(".dot.working")).not.toBeNull();
    expect(status?.textContent).toContain("mcp__muon__peer_inbox");
    // The old banner is gone, wording and warning slab together.
    expect(document.body.textContent).not.toContain(
      "Restored active mission turn"
    );
    expect(document.querySelector(".idle-terminal-notice")).toBeNull();
  });

  it("is absent when the mission is idle — the send action is back", () => {
    render(React.createElement(ChatView, base({ onStopTurn: vi.fn() }) as never));
    expect(screen.queryByRole("button", { name: "Stop this turn" })).toBeNull();
    expect(document.querySelector(".composer-turn")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
  });

  it("dispatches the SAME governed stop call the banner made, once", () => {
    const onStopTurn = vi.fn();
    render(
      React.createElement(
        ChatView,
        base({ running: true, turnActivity: "writing files", onStopTurn }) as never
      )
    );
    const stop = screen.getByRole("button", { name: "Stop this turn" });
    fireEvent.click(stop);
    expect(onStopTurn).toHaveBeenCalledTimes(1);
    // A second click cannot double-fire the governed interrupt; the control
    // says what it is doing instead.
    fireEvent.click(stop);
    expect(onStopTurn).toHaveBeenCalledTimes(1);
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".composer-turn")?.textContent).toContain(
      "Stopping this turn…"
    );
  });

  /**
   * Finding 1 (HIGH) — the ONLY reset for `stopRequested` used to be
   * `!running && stopRequested`. If the interrupt CALL ITSELF failed (brain
   * unreachable, a 409 lease conflict, a transient 500) — as opposed to the
   * turn actually ending — `running` never flips, so the button stayed
   * disabled, Escape stayed gated off, and the activity text stayed
   * "Stopping this turn…" forever: the kill switch went permanently dead
   * until an app restart. A failed interrupt attempt must unlatch the
   * control for a retry instead.
   */
  it("resets the stop control for a retry when the interrupt CALL fails, without the turn ending", async () => {
    const onStopTurn = vi.fn().mockResolvedValue(false);
    render(
      React.createElement(
        ChatView,
        base({ running: true, turnActivity: "writing files", onStopTurn }) as never
      )
    );
    const stop = screen.getByRole("button", { name: "Stop this turn" });
    fireEvent.click(stop);
    expect(onStopTurn).toHaveBeenCalledTimes(1);
    // Same immediate latch as a normal click — presentation only.
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".composer-turn")?.textContent).toContain(
      "Stopping this turn…"
    );

    // The interrupt call reports failure. `running` NEVER changed — the turn
    // is still running, MUON just could not tell it to stop — so this reset
    // is not the existing `!running` effect; it is the new failure path.
    await waitFor(() =>
      expect((stop as HTMLButtonElement).disabled).toBe(false)
    );
    expect(document.querySelector(".composer-turn")?.textContent).toContain(
      "writing files"
    );
    expect(document.querySelector(".composer-turn")?.textContent).toContain(
      "Esc to interrupt"
    );

    // The human can retry, and it fires the SAME governed call again.
    fireEvent.click(stop);
    expect(onStopTurn).toHaveBeenCalledTimes(2);
  });

  it("interrupts on Esc from the composer (the terminal idiom)", () => {
    const onStopTurn = vi.fn();
    render(
      React.createElement(
        ChatView,
        base({ running: true, turnActivity: "reading repo", onStopTurn }) as never
      )
    );
    expect(document.querySelector(".composer-turn")?.textContent).toContain(
      "Esc to interrupt"
    );
    fireEvent.keyDown(document.querySelector(".composer")!, { key: "Escape" });
    expect(onStopTurn).toHaveBeenCalledTimes(1);
  });

  it("hands focus to the stop control when the send locks the composer", () => {
    // The textarea the human was typing in goes disabled; the browser would
    // drop focus to <body>. Focus stays in the composer, on the control that
    // now owns it — which is also what makes "Esc to interrupt" true.
    const onStopTurn = vi.fn();
    const onSend = vi.fn();
    const { rerender } = render(
      React.createElement(ChatView, base({ onSend, onStopTurn }) as never)
    );
    fireEvent.change(screen.getByLabelText("Message to MUON"), {
      target: { value: "ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("ship it");
    rerender(
      React.createElement(
        ChatView,
        base({ running: true, onSend, onStopTurn }) as never
      )
    );
    const stop = screen.getByRole("button", { name: "Stop this turn" });
    expect(document.activeElement).toBe(stop);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onStopTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps the composer available for queued follow-ups while the turn runs", () => {
    render(
      React.createElement(
        ChatView,
        base({ running: true, turnActivity: "planning", onStopTurn: vi.fn() }) as never
      )
    );
    const input = screen.getByLabelText("Message to MUON") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(document.getElementById("composer-hint")?.textContent).toBe(
      "Turn running — Enter queues · Send now steers the root job · Esc stops · ⌘K commands"
    );
  });

  it("states the turn is running even before an activity is reported", () => {
    render(
      React.createElement(
        ChatView,
        base({ running: true, onStopTurn: vi.fn() }) as never
      )
    );
    expect(document.querySelector(".composer-turn")?.textContent).toContain(
      "Working…"
    );
  });

  it("shows the running state WITHOUT a stop when there is no job to stop yet", () => {
    // The optimistic window between "the human hit send" and "the brain has a
    // root job". A stop that cannot stop anything is never offered.
    render(React.createElement(ChatView, base({ running: true }) as never));
    expect(screen.queryByRole("button", { name: "Stop this turn" })).toBeNull();
    expect(document.querySelector(".composer-turn")).not.toBeNull();
    expect(document.querySelector(".composer-turn")?.textContent).not.toContain(
      "Esc to interrupt"
    );
  });

  it("surfaces an approval wait as the activity, not as an alarm", () => {
    render(
      React.createElement(
        ChatView,
        base({
          running: true,
          turnActivity: "Waiting for your approval",
          onStopTurn: vi.fn(),
        }) as never
      )
    );
    const status = document.querySelector(".composer-turn");
    expect(status?.textContent).toContain("Waiting for your approval");
    expect(status?.className).not.toMatch(/warn|error|alert/);
    expect(status?.getAttribute("role")).toBe("status");
  });

  it("keeps a queued steer visible when delivery fails and removes it after retry", async () => {
    const onSteerNow = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockResolvedValueOnce(undefined);
    render(
      React.createElement(
        ChatView,
        base({ running: true, onSteerNow }) as never
      )
    );
    fireEvent.change(screen.getByLabelText("Message to MUON"), {
      target: { value: "check the parser too" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message to MUON"), {
      key: "Enter",
    });

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await screen.findByText(/Not sent: runtime unavailable/);
    expect(screen.getByText(/Queued: check the parser too/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() =>
      expect(screen.queryByText(/Queued: check the parser too/)).toBeNull()
    );
    expect(onSteerNow).toHaveBeenCalledTimes(2);
  });
});
