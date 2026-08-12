// @vitest-environment jsdom
//
// R3 TTL on the desktop memory surface. An unconfirmed, low/medium-trust,
// agent-authored note lapses after its TTL and is hidden from recall by
// default. Before this, the desktop simply stopped showing it — no badge, no
// explanation, no way back — which is indistinguishable from "memory is
// broken". These tests pin the four things that make the lapse legible and
// reversible: the toggle round-trips through the GOVERNED read, the badge is
// its own third state, confirming redeems, and an all-expired library says so.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryLibraryNote } from "@muon/client/memory-library";
import { MemoryWorkspace } from "../src/renderer/memory-workspace.js";
import { MemoryPanel } from "../src/renderer/brain.js";

const DAY = 86_400_000;

function note(overrides: Partial<MemoryLibraryNote> = {}): MemoryLibraryNote {
  return {
    id: "mem-live",
    kind: "decision",
    text: "Use the streaming parser.",
    taskId: null,
    laneId: null,
    modules: ["src/parser.ts"],
    topics: [],
    symbols: [],
    trust: "high",
    confirmed: true,
    stale: false,
    status: "active",
    scope: "project",
    createdBy: "human:founder",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    accessCount: 0,
    expiresAt: null,
    expired: false,
    pinned: false,
    provenance: null,
    ...overrides,
  };
}

const liveNote = note({
  id: "mem-live",
  // An unconfirmed agent note that has NOT lapsed yet: the countdown is the
  // warning we owe the user before it vanishes.
  confirmed: false,
  trust: "medium",
  createdBy: "agent:claude-code",
  text: "Tokenization stays byte-oriented.",
  expiresAt: new Date(Date.now() + 12 * DAY).toISOString(),
  expired: false,
});

const expiredNote = note({
  id: "mem-expired",
  confirmed: false,
  trust: "low",
  createdBy: "agent:codex",
  text: "The retry budget was probably three.",
  expiresAt: new Date(Date.now() - 3 * DAY).toISOString(),
  expired: true,
});

function snapshot(notes: MemoryLibraryNote[], total = notes.length) {
  return {
    notes,
    edges: [],
    confirmations: [],
    imports: [],
    analytics: {
      noteScores: [],
      hotModules: [],
      communities: [],
      source: { notes: 0, modules: 0, edges: 0, truncated: false },
    },
    total,
    truncated: false,
  };
}

type LibraryQuery = { showExpired?: boolean; limit?: number };

function installBridge(bridge: Record<string, unknown>) {
  Object.defineProperty(window, "muon", {
    configurable: true,
    writable: true,
    value: bridge as Window["muon"],
  });
  return bridge;
}

async function openLibrary(): Promise<void> {
  expect(await screen.findByLabelText("Memory workspace")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: /^Library$/ }));
}

function libraryGrid(): HTMLElement {
  // The library list is the LAST card grid on screen (the inbox tab is not
  // mounted at the same time), scoped so inbox copy can never satisfy a query.
  const grids = document.querySelectorAll(".memory-card-grid");
  const grid = grids[grids.length - 1];
  if (!grid) throw new Error("memory card grid not rendered");
  return grid as HTMLElement;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "muon");
  vi.clearAllMocks();
});

describe("desktop memory library — R3 expiry", () => {
  it("shows source provenance and keeps permanent forgetting behind pin protection", () => {
    const onDecide = vi.fn();
    const pinned = note({
      id: "mem-pinned",
      pinned: true,
      scope: "global",
      provenance: {
        sourceType: "job",
        rawRef: "job:review-pr-17",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    });
    render(
      <MemoryWorkspace
        snapshot={snapshot([pinned])}
        loading={false}
        error={null}
        query=""
        onQueryChange={vi.fn()}
        onRefresh={vi.fn()}
        onDecide={onDecide}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Library$/ }));
    const card = within(libraryGrid())
      .getByText("Use the streaming parser.")
      .closest("article");
    expect(card).toBeTruthy();
    expect(within(card!).getByText("PINNED")).toBeTruthy();
    expect(within(card!).getByText("job:review-pr-17")).toBeTruthy();
    expect(within(card!).getByText(/Saved during/)).toBeTruthy();
    const forget = within(card!).getByRole("button", {
      name: "Forget permanently",
    }) as HTMLButtonElement;
    expect(forget.disabled).toBe(true);
    const unpin = within(card!).getByRole("button", { name: "Unpin" });
    expect(unpin.getAttribute("title")).toContain("new agent briefs");
    fireEvent.click(unpin);
    expect(onDecide).toHaveBeenCalledWith("mem-pinned", "unpin");
  });

  it("requires explicit confirmation before invoking permanent forget", async () => {
    const memoryLibrary = vi.fn().mockResolvedValue(snapshot([note()]));
    const deleteMemoryNote = vi.fn().mockResolvedValue({
      noteId: "mem-live",
      deleted: true,
      alreadyDeleted: false,
    });
    installBridge({
      memoryLibrary,
      updateMemoryNote: vi.fn(),
      deleteMemoryNote,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<MemoryPanel chatId="chat-a" />);
    await openLibrary();
    fireEvent.click(
      screen.getByRole("button", { name: "Forget permanently" })
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("cannot be restored")
    );
    expect(deleteMemoryNote).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Forget permanently" })
    );
    await waitFor(() =>
      expect(deleteMemoryNote).toHaveBeenCalledWith("mem-live")
    );
    await waitFor(() => expect(memoryLibrary).toHaveBeenCalledTimes(2));
  });

  it("hides expired notes by default and round-trips Show expired through the governed read", async () => {
    const memoryLibrary = vi.fn(async (query?: LibraryQuery) =>
      query?.showExpired
        ? snapshot([liveNote, expiredNote])
        : snapshot([liveNote])
    );
    installBridge({ memoryLibrary, updateMemoryNote: vi.fn() });

    render(<MemoryPanel chatId="chat-a" />);
    await openLibrary();

    // Default posture: the flag is sent EXPLICITLY as false — the renderer
    // never filters locally, the backend decides what is visible.
    await waitFor(() =>
      expect(memoryLibrary).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: "chat-a", showExpired: false })
      )
    );
    expect(screen.queryByText("EXPIRED")).toBeNull();
    expect(
      screen.queryByText("The retry budget was probably three.")
    ).toBeNull();

    const toggle = screen.getByRole("checkbox", { name: "Show expired" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(memoryLibrary).toHaveBeenCalledWith(
        expect.objectContaining({ showExpired: true, limit: 200 })
      )
    );
    expect(
      await screen.findByText("The retry budget was probably three.")
    ).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Show expired" }) as HTMLInputElement).checked).toBe(
      true
    );

    // Flipping it back re-asks the backend rather than re-filtering.
    fireEvent.click(screen.getByRole("checkbox", { name: "Show expired" }));
    await waitFor(() =>
      expect(
        screen.queryByText("The retry budget was probably three.")
      ).toBeNull()
    );
  });

  it("marks an expired note as its own third state and counts a live note down", () => {
    render(
      <MemoryWorkspace
        snapshot={snapshot([liveNote, expiredNote])}
        loading={false}
        error={null}
        query=""
        onQueryChange={vi.fn()}
        onRefresh={vi.fn()}
        onDecide={vi.fn()}
        showExpired
        onShowExpiredChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Library$/ }));
    const grid = libraryGrid();

    const expiredCard = within(grid)
      .getByText("The retry budget was probably three.")
      .closest("article");
    expect(expiredCard).toBeTruthy();
    // The badge is EXPIRED, not a shade of the stale warning.
    expect(within(expiredCard!).getByText("EXPIRED")).toBeTruthy();
    expect(within(expiredCard!).queryByText("May be outdated")).toBeNull();
    expect(expiredCard!.className).toContain("expired");
    expect(within(expiredCard!).getByText("Expired 3 days ago")).toBeTruthy();

    // A LIVE note's remaining life is legible before it lapses.
    const liveCard = within(grid)
      .getByText("Tokenization stays byte-oriented.")
      .closest("article");
    expect(within(liveCard!).getByText("Expires in 12 days")).toBeTruthy();
    expect(within(liveCard!).queryByText("EXPIRED")).toBeNull();
  });

  it("keeps redemption reachable: confirming an expired note clears the expiry in place", async () => {
    const redeemed: MemoryLibraryNote = {
      ...expiredNote,
      confirmed: true,
      expiresAt: null,
      expired: false,
    };
    let confirmed = false;
    const memoryLibrary = vi.fn(async (query?: LibraryQuery) =>
      snapshot(
        query?.showExpired ? [confirmed ? redeemed : expiredNote] : []
      )
    );
    const updateMemoryNote = vi.fn(async () => {
      confirmed = true;
      return redeemed;
    });
    installBridge({ memoryLibrary, updateMemoryNote });

    render(<MemoryPanel chatId="chat-a" />);
    await openLibrary();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show expired" }));
    expect(await screen.findByText("EXPIRED")).toBeTruthy();

    // The library card of a lapsed note offers the rescue, not just the inbox.
    const restore = within(libraryGrid()).getByRole("button", {
      name: "Confirm to restore",
    });
    fireEvent.click(restore);

    await waitFor(() =>
      expect(updateMemoryNote).toHaveBeenCalledWith({
        noteId: "mem-expired",
        confirmed: true,
        principal: "human",
      })
    );
    // The badge is gone on the reload — the note is visibly un-expired, and it
    // keeps its text (expiry hides, it never deletes).
    await waitFor(() => expect(screen.queryByText("EXPIRED")).toBeNull());
    expect(
      screen.getByText("The retry budget was probably three.")
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Confirm to restore" })
    ).toBeNull();
  });

  it("says WHY the library is empty when everything in it expired, and offers the way back", async () => {
    const memoryLibrary = vi.fn(async (query?: LibraryQuery) => {
      if (!query?.showExpired) return snapshot([], 0);
      // The bounded probe (limit 1) reports the true count; the full read
      // returns the notes themselves.
      return query.limit === 1
        ? snapshot([expiredNote], 3)
        : snapshot([expiredNote], 3);
    });
    installBridge({ memoryLibrary, updateMemoryNote: vi.fn() });

    render(<MemoryPanel chatId="chat-a" />);
    await openLibrary();

    expect(
      await screen.findByText("Nothing live here — 3 memories expired.")
    ).toBeTruthy();
    expect(screen.getByText(/hidden, not deleted/)).toBeTruthy();
    // The probe is bounded and asks the same governed read.
    expect(memoryLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ showExpired: true, limit: 1 })
    );

    fireEvent.click(screen.getByRole("button", { name: "Show expired" }));
    expect(
      await screen.findByText("The retry budget was probably three.")
    ).toBeTruthy();
    expect(screen.getByText(/1 expired/)).toBeTruthy();
  });

  it("falls back to an honest empty message when the expiry probe fails", async () => {
    const memoryLibrary = vi.fn(async (query?: LibraryQuery) => {
      if (query?.showExpired) throw new Error("probe unavailable");
      return snapshot([], 0);
    });
    installBridge({ memoryLibrary, updateMemoryNote: vi.fn() });

    render(<MemoryPanel chatId="chat-a" />);
    await openLibrary();

    expect(await screen.findByText("No memories yet.")).toBeTruthy();
    expect(screen.getByText(/turn on Show expired/)).toBeTruthy();
    // A failed probe is not a library failure — no error banner is raised.
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});
