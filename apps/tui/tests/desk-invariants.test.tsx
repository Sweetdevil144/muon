import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import { App } from "../src/components/App.js";
import type { BrainSnapshot, BrainStore } from "../src/lib/brain-store.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";

/**
 * A store that can PUSH a new snapshot, so a test can observe a rail reorder
 * without pressing a key. Pressing j/k to force a re-render would move the
 * cursor itself, which is exactly the behaviour under test.
 */
function liveStore(initial: BrainSnapshot): BrainStore & {
  push: (next: BrainSnapshot) => void;
} {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    client: new MuonApiClient("http://localhost:4000", async () => {
      throw new Error("no network in render tests");
    }),
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: async () => undefined,
    start: () => undefined,
    stop: () => undefined,
    push: (next: BrainSnapshot) => {
      current = next;
      for (const listener of listeners) listener();
    },
  } as BrainStore & { push: (next: BrainSnapshot) => void };
}

function stubStore(snapshot: BrainSnapshot): BrainStore {
  return {
    client: new MuonApiClient("http://localhost:4000", async () => {
      throw new Error("no network in render tests");
    }),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    start: () => undefined,
    stop: () => undefined,
  };
}

// ADR-0032 D1 — the invariant this whole feature exists to establish: no view,
// panel, or modal may take the screen away from the crew and the inbox.
//
// Before this, opening any of eleven overlays replaced the entire cockpit with
// a one-line summary, so the operator could not read an approval and watch the
// fleet at the same time — the moment both matter most.

function busySnapshot(): BrainSnapshot {
  return {
    ...emptyBrainSnapshot(),
    agents: [
      {
        id: "agent-1",
        vendor: "codex",
        name: "crew-1",
        ordinal: 1,
        status: "working",
        currentTaskId: "task-1",
        currentJobId: "job-1",
      },
    ],
    tasks: [
      {
        id: "task-1",
        title: "Feature 1",
        description: "",
        status: "in_progress",
        priority: "high",
      },
    ],
    dispatchJobs: [
      {
        id: "job-1",
        agentId: "agent-1",
        taskId: "task-1",
        status: "running",
        interruptRequested: false,
        createdAt: new Date().toISOString(),
        currentActivity: "working feature 1",
      } as import("@muon/client").DispatchJobRecord,
    ],
  };
}

/** Every key that opens a center panel, with the keystrokes to get there. */
const PANEL_OPENERS: { name: string; keys: string[] }[] = [
  { name: "keymap help", keys: ["?"] },
  { name: "command palette", keys: [""] },
];

describe("ADR-0032 D1 — the inbox never leaves the screen", () => {
  it("keeps the inbox mounted while each center panel is open", async () => {
    for (const opener of PANEL_OPENERS) {
      const store = stubStore(busySnapshot());
      const { lastFrame, stdin, unmount } = render(
        React.createElement(App, { store, widthOverride: 170 })
      );

      expect(lastFrame() ?? "", "inbox missing before opening").toContain(
        "NEEDS YOUR DECISION"
      );

      for (const key of opener.keys) stdin.write(key);
      await vi.waitFor(() => {
        expect(
          lastFrame() ?? "",
          `${opener.name} did not open`
        ).not.toBe("");
      });

      expect(
        lastFrame() ?? "",
        `${opener.name} blanked the inbox`
      ).toContain("NEEDS YOUR DECISION");

      unmount();
    }
  });

  it("keeps the crew visible (collapsed, never gone) while a panel is open", async () => {
    const store = stubStore(busySnapshot());
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );
    expect(lastFrame() ?? "").toContain("FLEET");

    stdin.write("?");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("KEYS"));

    // The rail collapses to attention glyphs rather than unmounting: a working
    // lane still shows its dot, so "is anything on fire" is answerable without
    // closing the panel.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NEEDS YOUR DECISION");
    expect(frame).toMatch(/[●◆✗▲✓○]/);
    unmount();
  });

  it("returns to the full rail when the panel closes", async () => {
    const store = stubStore(busySnapshot());
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );
    stdin.write("?");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("KEYS"));
    stdin.write("");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("FLEET"));
    expect(lastFrame() ?? "").toContain("NEEDS YOUR DECISION");
    unmount();
  });
});

describe("ADR-0032 D2 — tabs", () => {
  it("shows chat and crew as coexisting tabs at desk width", () => {
    const store = stubStore(busySnapshot());
    const { lastFrame, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 chat");
    expect(frame).toContain("2 crew");
    unmount();
  });

  it("switches by ordinal without losing the rail or inbox", async () => {
    const store = stubStore(busySnapshot());
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );
    stdin.write("2");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("CREW DESK"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("FLEET");
    expect(frame).toContain("NEEDS YOUR DECISION");
    unmount();
  });

  it("refuses to close a permanent tab and says so", async () => {
    const store = stubStore(busySnapshot());
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );
    stdin.write("x");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("chat and crew stay open")
    );
    expect(lastFrame() ?? "").toContain("1 chat");
    unmount();
  });
});

describe("ADR-0032 D4/D5 — rail ordering cannot redirect an action", () => {
  function blockedLastSnapshot(): BrainSnapshot {
    // Three lanes; the BLOCKED one arrives last in the raw fleet order, so a
    // surface that renders sorted while resolving unsorted would act on the
    // wrong lane.
    return {
      ...emptyBrainSnapshot(),
      agents: ["calm-1", "calm-2", "blocked-3"].map((id, index) => ({
        id,
        vendor: "codex",
        name: id,
        ordinal: index + 1,
        status: "working",
        currentTaskId: `task-${index + 1}`,
        currentJobId: `job-${index + 1}`,
      })),
      // Tasks present so the first-run onboarding panel does not claim the
      // rows the rail is being asserted on.
      tasks: [1, 2, 3].map((n) => ({
        id: `task-${n}`,
        title: `Feature ${n}`,
        description: "",
        status: "in_progress" as const,
        priority: "high" as const,
      })),
      dispatchJobs: [1, 2, 3].map(
        (n) =>
          ({
            id: `job-${n}`,
            agentId: n === 3 ? "blocked-3" : `calm-${n}`,
            taskId: `task-${n}`,
            status: "running",
            interruptRequested: false,
            createdAt: new Date().toISOString(),
            lastProgressAt: new Date().toISOString(),
            waitingApproval: n === 3,
          }) as import("@muon/client").DispatchJobRecord
      ),
    };
  }

  it("sorts the blocked lane to the top of the rail", async () => {
    const store = stubStore(blockedLastSnapshot());
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );
    stdin.write("\t"); // focus the crew rail
    await vi.waitFor(() => expect(lastFrame() ?? "").toMatch(/›\s*◆\s*blocked-3/));
    unmount();
  });

  it("resolves `o` to the lane the rail actually shows first", async () => {
    const store = stubStore(blockedLastSnapshot());
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );
    stdin.write("o");
    // The status line names the lane it jumped to; if selection resolved
    // against the unsorted fleet this would name calm-1.
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("blocked-3"));
    unmount();
  });

  it("a lane parked at a gate stays first even after being opened", async () => {
    // ADR-0032 D3: looking is not deciding. Opening the blocked lane's stream
    // must not demote it out of the top slot.
    const store = stubStore(blockedLastSnapshot());
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );
    stdin.write("\t");
    await vi.waitFor(() => expect(lastFrame() ?? "").toMatch(/›\s*◆\s*blocked-3/));
    stdin.write("\r"); // open its stream — marks it seen
    await vi.waitFor(() => expect(lastFrame() ?? "").not.toBe(""));
    stdin.write(""); // close
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("FLEET"));
    expect(lastFrame() ?? "").toMatch(/›\s*◆\s*blocked-3/);
    unmount();
  });
  it("keeps the cursor on the AGENT when a reorder moves it (Greptile P1)", async () => {
    // The defect Greptile found: the rail reorders whenever a lane's attention
    // changes, so a numeric cursor silently lands on whoever inherited that
    // row — and `s`, Enter and `b` then act on an agent the operator did not
    // choose. Selection is bound to the agent id, so the cursor travels with it.
    const calm = blockedLastSnapshot();
    calm.dispatchJobs = calm.dispatchJobs.map((job) => ({
      ...job,
      waitingApproval: false,
    })) as typeof calm.dispatchJobs;
    const store = liveStore(calm);
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );

    stdin.write("\t"); // focus the rail
    await vi.waitFor(() => expect(lastFrame() ?? "").toMatch(/›\s*●\s*calm-1/));
    stdin.write("j"); // select calm-2, the middle row
    await vi.waitFor(() => expect(lastFrame() ?? "").toMatch(/›\s*●\s*calm-2/));

    // blocked-3 now needs a human and sorts to the top, pushing calm-2 down a
    // row. Pushed through the store, so no keystroke is involved.
    store.push({
      ...calm,
      dispatchJobs: calm.dispatchJobs.map((job) =>
        job.agentId === "blocked-3" ? { ...job, waitingApproval: true } : job
      ),
    } as BrainSnapshot);

    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toMatch(/◆\s*blocked-3/)
    );
    // The cursor is still on calm-2 — now the third row, not the second.
    expect(lastFrame() ?? "", "the cursor did not follow its agent").toMatch(
      /›\s*●\s*calm-2/
    );
    unmount();
  });
});

describe("ADR-0032 D6 — the keymap is discoverable", () => {
  it("opens the generated help and filters it", async () => {
    const store = stubStore(busySnapshot());
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 170 })
    );
    stdin.write("?");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("KEYS"));
    // The help is generated from the table, so a binding added there shows up
    // here without anyone remembering to update a help string.
    expect(lastFrame() ?? "").toContain("next tab");

    stdin.write("approve");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("filter: approve")
    );
    expect(lastFrame() ?? "").not.toContain("next tab");
    unmount();
  });
});
