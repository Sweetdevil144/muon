// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MissionCapControl } from "../src/renderer/mission-cap.js";
import type { MissionCapState } from "../src/shared/ipc.js";

afterEach(cleanup);

/**
 * Parity item 4. Every property here is about the cap MEANING the same thing
 * on the desk as it does in `muon cost`: the same inputs refused, the same one
 * rendering of the figure, and the same promise that a cap brakes new work
 * rather than killing running work.
 */
function state(overrides: Partial<MissionCapState> = {}): MissionCapState {
  return {
    chatId: "chat-1",
    capUsd: null,
    capSetBy: null,
    summary: "≥ $4.20 observed across 1 of 3 reporting lanes. No cap.",
    refusesDispatch: false,
    ...overrides,
  };
}

describe("MissionCapControl", () => {
  it("renders nothing without a mission — a cap belongs to one", () => {
    const { container } = render(
      <MissionCapControl chatId={null} load={vi.fn()} save={vi.fn()} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows the backend's SENTENCE, not a figure it formatted itself", async () => {
    render(
      <MissionCapControl
        chatId="chat-1"
        load={vi.fn(async () => state())}
        save={vi.fn()}
      />
    );
    // D1: the coverage rides with the number. A surface that renders its own
    // total drops the "≥" and the reporting-lane count, and a human then
    // decides against a figure that looks complete and is not.
    expect(
      await screen.findByText(/≥ \$4\.20 observed across 1 of 3/)
    ).toBeTruthy();
  });

  it("refuses a zero cap with the CLI's own words, before any write", async () => {
    const save = vi.fn();
    render(
      <MissionCapControl
        chatId="chat-1"
        load={vi.fn(async () => state())}
        save={save}
      />
    );
    await screen.findByText(/observed across/);
    fireEvent.change(screen.getByLabelText("Cap in dollars"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByText("Set cap"));
    expect(await screen.findByText(/Zero is refused/)).toBeTruthy();
    expect(save, "a refused cap must never reach the brain").not.toHaveBeenCalled();
  });

  it("sends a valid cap and adopts the answer, not the typed value", async () => {
    const save = vi.fn(async () =>
      state({ capUsd: 25, summary: "≥ $4.20 observed. Cap $25.00." })
    );
    render(
      <MissionCapControl
        chatId="chat-1"
        load={vi.fn(async () => state())}
        save={save}
      />
    );
    await screen.findByText(/observed across/);
    fireEvent.change(screen.getByLabelText("Cap in dollars"), {
      target: { value: "$25" },
    });
    fireEvent.click(screen.getByText("Set cap"));
    expect(await screen.findByText(/Cap \$25\.00\./)).toBeTruthy();
    expect(save).toHaveBeenCalledWith(25);
  });

  it("clears with null, never with a zero", async () => {
    const save = vi.fn(async () => state({ capUsd: null }));
    render(
      <MissionCapControl
        chatId="chat-1"
        load={vi.fn(async () => state({ capUsd: 25 }))}
        save={save}
      />
    );
    await screen.findByText(/observed across/);
    fireEvent.click(screen.getByText("Clear"));
    expect(save).toHaveBeenCalledWith(null);
  });

  it("says a met cap refuses the NEXT dispatch and stopped nothing", async () => {
    render(
      <MissionCapControl
        chatId="chat-1"
        load={vi.fn(async () => state({ capUsd: 1, refusesDispatch: true }))}
        save={vi.fn()}
      />
    );
    expect(await screen.findByText(/NEXT dispatch/)).toBeTruthy();
    expect(screen.getByText(/was not stopped/)).toBeTruthy();
  });

  it("an unreadable cap is reported, never rendered as 'no cap'", async () => {
    render(
      <MissionCapControl
        chatId="chat-1"
        load={vi.fn(async () => {
          throw new Error("brain unreachable");
        })}
        save={vi.fn()}
      />
    );
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.getByText("unreadable")).toBeTruthy();
  });

  it("a failed write surfaces the reason and keeps the old cap on screen", async () => {
    render(
      <MissionCapControl
        chatId="chat-1"
        load={vi.fn(async () => state({ capUsd: 25 }))}
        save={vi.fn(async () => {
          throw new Error("the selection changed while it saved");
        })}
      />
    );
    await screen.findByText(/observed across/);
    fireEvent.change(screen.getByLabelText("Cap in dollars"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByText("Set cap"));
    expect(
      await screen.findByText(/the selection changed while it saved/)
    ).toBeTruthy();
    expect(screen.getByText("$25.00")).toBeTruthy();
  });

  it("a slow read for the PREVIOUS mission cannot paint over the current one", async () => {
    let call = 0;
    const load = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return state({ chatId: "chat-old", summary: "STALE mission summary" });
      }
      return state({ chatId: "chat-new", summary: "current mission summary" });
    });
    const { rerender } = render(
      <MissionCapControl chatId="chat-old" load={load} save={vi.fn()} />
    );
    rerender(
      <MissionCapControl chatId="chat-new" load={load} save={vi.fn()} />
    );
    expect(await screen.findByText("current mission summary")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.queryByText("STALE mission summary")).toBeNull();
  });

  it("renders nothing on a preload that cannot write a cap", () => {
    // Read-without-write would be the audit finding again, dressed as a panel.
    const prior = (window as unknown as { muon?: unknown }).muon;
    (window as unknown as { muon: Record<string, unknown> }).muon = {
      missionCost: async () => state(),
    };
    try {
      const { container } = render(<MissionCapControl chatId="chat-1" />);
      expect(container.innerHTML).toBe("");
    } finally {
      (window as unknown as { muon?: unknown }).muon = prior;
    }
  });

  it("discards a reading that names a DIFFERENT mission", async () => {
    // Main's bound chat lags the renderer's selection by one async hop, so a
    // read issued at that moment answers for the previous mission. Untagged,
    // the panel would show that mission's cap under this one's name.
    render(
      <MissionCapControl
        chatId="chat-new"
        load={vi.fn(async () =>
          state({ chatId: "chat-old", capUsd: 999, summary: "another mission" })
        )}
        save={vi.fn()}
      />
    );
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByText("another mission")).toBeNull();
    expect(screen.queryByText("$999.00")).toBeNull();
  });

  it("a write that landed on another mission is REPORTED, not painted", async () => {
    render(
      <MissionCapControl
        chatId="chat-new"
        load={vi.fn(async () => state({ chatId: "chat-new" }))}
        save={vi.fn(async () => state({ chatId: "chat-old", capUsd: 50 }))}
      />
    );
    await screen.findByText(/observed across/);
    fireEvent.change(screen.getByLabelText("Cap in dollars"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByText("Set cap"));
    expect(await screen.findByText(/was saved on the mission that was selected/)).toBeTruthy();
    // The cap for THIS mission is unchanged on screen.
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("switching missions mid-save does not leave the control disabled forever", async () => {
    // The control is not keyed by chat and stays mounted, so a `saving` flag
    // that never clears disables the input and both buttons for the rest of
    // the session.
    let settle: (value: MissionCapState) => void = () => {};
    const save = vi.fn(
      () => new Promise<MissionCapState>((resolve) => (settle = resolve))
    );
    const { rerender } = render(
      <MissionCapControl
        chatId="chat-old"
        load={vi.fn(async () => state({ chatId: "chat-old" }))}
        save={save}
      />
    );
    await screen.findByText(/observed across/);
    fireEvent.change(screen.getByLabelText("Cap in dollars"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByText("Set cap"));

    // The human moves on while the write is in flight.
    rerender(
      <MissionCapControl
        chatId="chat-new"
        load={vi.fn(async () => state({ chatId: "chat-new" }))}
        save={save}
      />
    );
    settle(state({ chatId: "chat-old", capUsd: 25 }));
    await screen.findByText(/observed across/);

    fireEvent.change(screen.getByLabelText("Cap in dollars"), {
      target: { value: "50" },
    });
    const button = screen.getByText("Set cap") as HTMLButtonElement;
    expect(button.disabled, "the control is usable again").toBe(false);
  });
});
