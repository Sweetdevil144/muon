// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_TRAVERSAL_TEXT_POLICY } from "@muon/client";
import {
  MemoryWorkspace,
  neighborRows,
} from "../src/renderer/memory-workspace.js";

afterEach(() => {
  cleanup();
  delete (window as unknown as { muon?: unknown }).muon;
});

const snapshot = {
  notes: [
    {
      id: "mem-confirmed",
      kind: "decision" as const,
      text: "Use the streaming parser.",
      modules: ["src/parser.ts"],
      topics: ["parser"],
      symbols: ["src/parser.ts#parse"],
      trust: "high" as const,
      confirmed: true,
      stale: false,
      status: "active" as const,
      scope: "project",
      createdBy: "agent:codex",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    },
    {
      id: "mem-proposal",
      kind: "constraint" as const,
      text: "Do not change parser tokenization.",
      modules: ["src/parser.ts"],
      topics: ["parser"],
      symbols: [],
      trust: "medium" as const,
      confirmed: false,
      stale: false,
      status: "active" as const,
      scope: "project",
      createdBy: "agent:claude-code",
      createdAt: "2026-07-16T01:00:00.000Z",
      updatedAt: "2026-07-16T01:00:00.000Z",
    },
  ],
  edges: [
    {
      id: "edge-1",
      fromId: "mem-proposal",
      toId: "mem-confirmed",
      kind: "contradicts",
      weight: null,
      at: "2026-07-16T01:00:00.000Z",
    },
  ],
  confirmations: [
    {
      id: "confirmation-1",
      noteId: "mem-confirmed",
      principal: "human:founder",
      decision: "confirm" as const,
      at: "2026-07-16T02:00:00.000Z",
    },
  ],
  analytics: {
    noteScores: [
      {
        noteId: "mem-confirmed",
        score: 0.8,
        degree: 2,
        communityId: "community-1",
      },
    ],
    hotModules: [
      {
        module: "src/parser.ts",
        score: 1,
        noteCount: 2,
        communityId: "community-1",
      },
    ],
    communities: [
      { id: "community-1", noteCount: 2, moduleCount: 1 },
    ],
    source: { notes: 2, modules: 1, edges: 2, truncated: false },
  },
  total: 2,
  truncated: false,
};

describe("MemoryWorkspace", () => {
  it("keeps paused memory out of the crew inbox and offers one-action resume in the library", () => {
    const onDecide = vi.fn();
    render(
      React.createElement(MemoryWorkspace, {
        snapshot: {
          ...snapshot,
          notes: [
            {
              ...snapshot.notes[0]!,
              id: "mem-paused",
              text: "A temporarily withheld constraint.",
              status: "paused" as const,
            },
          ],
          total: 1,
        },
        loading: false,
        error: null,
        query: "",
        onQueryChange: vi.fn(),
        onRefresh: vi.fn(),
        onDecide,
      })
    );

    expect(screen.queryByText("A temporarily withheld constraint.")).toBeNull();
    expect(screen.getByRole("tab", { name: "Crew memory" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByText("Paused · hidden from crew")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onDecide).toHaveBeenCalledWith("mem-paused", "resume");
  });

  it("collapses oversized memory bodies while keeping the navigation available", () => {
    const longText = Array.from(
      { length: 20 },
      (_, index) => `Section ${index + 1}: governed memory detail`
    ).join("\n");
    render(
      React.createElement(MemoryWorkspace, {
        snapshot: {
          ...snapshot,
          notes: [
            {
              ...snapshot.notes[0]!,
              id: "mem-long",
              text: longText,
            },
          ],
          total: 1,
        },
        loading: false,
        error: null,
        query: "",
        onQueryChange: vi.fn(),
        onRefresh: vi.fn(),
        onDecide: vi.fn(),
      })
    );

    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    const disclosure = screen.getByText("Show full memory").closest("details");
    expect(disclosure?.hasAttribute("open")).toBe(false);
    expect(screen.getByRole("tab", { name: "Crew memory" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Graph" })).toBeTruthy();
  });

  it("provides one-action review, searchable library, trusted-default graph, and provenance", () => {
    const onDecide = vi.fn();
    render(
      React.createElement(MemoryWorkspace, {
        snapshot,
        loading: false,
        error: null,
        query: "",
        onQueryChange: vi.fn(),
        onRefresh: vi.fn(),
        onDecide,
      })
    );

    expect(screen.getByText("Do not change parser tokenization.")).toBeTruthy();
    expect(screen.getByText("Hot modules")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onDecide).toHaveBeenCalledWith("mem-proposal", "confirm");

    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByRole("searchbox", { name: "Search all memory" })).toBeTruthy();
    expect(screen.getByText("Use the streaming parser.")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(screen.getByRole("img", { name: "Memory relationship graph" })).toBeTruthy();
    expect(screen.getByText("In crew use")).toBeTruthy();
    expect(screen.queryByText("Do not change parser tokenization.")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include pending proposals" }));
    expect(
      screen.getAllByText("Do not change parser tokenization.").length
    ).toBeGreaterThan(0);
    expect(screen.getByRole("table", { name: "Accessible memory graph data" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Provenance" }));
    expect(screen.getByText("human:founder confirmed")).toBeTruthy();
    expect(screen.getByText("agent:codex authored")).toBeTruthy();
  });

  // F10: `sweepExpiredMemory` writes an audit row `{principal: "system:ttl",
  // decision: "expire"}`. Rendering every unknown decision as a review flag
  // turned an automatic retention eviction into "system:ttl flagged for review
  // (expire)" — an item the operator is told to adjudicate that no human is ever
  // asked to touch.
  it("renders the TTL sweeper's audit row as a retention eviction, not a review flag", () => {
    render(
      React.createElement(MemoryWorkspace, {
        snapshot: {
          ...snapshot,
          confirmations: [
            ...snapshot.confirmations,
            {
              id: "confirmation-ttl",
              noteId: "mem-proposal",
              principal: "system:ttl",
              decision: "expire" as const,
              at: "2026-07-17T00:00:00.000Z",
            },
            // An unknown system marker still reads as neutral — the rule that a
            // decision this renderer does not know is NEVER shown as a confirm
            // or a reject is unchanged.
            {
              id: "confirmation-reconcile",
              noteId: "mem-proposal",
              principal: "system:reconcile",
              decision: "reconcile" as const,
              at: "2026-07-17T01:00:00.000Z",
            },
          ],
        },
        loading: false,
        error: null,
        query: "",
        onQueryChange: vi.fn(),
        onRefresh: vi.fn(),
        onDecide: vi.fn(),
      })
    );

    fireEvent.click(screen.getByRole("tab", { name: "Provenance" }));
    expect(
      screen.getByText("system:ttl expired by retention policy")
    ).toBeTruthy();
    expect(screen.queryByText("system:ttl flagged for review (expire)")).toBeNull();
    expect(
      screen.getByText("system:reconcile flagged for review (reconcile)")
    ).toBeTruthy();
  });

  it("loads 'Why the brain believes this' from the governed explanation IPC", async () => {
    const memoryExplain = vi.fn().mockResolvedValue({
      noteId: "mem-confirmed",
      path: {
        nodes: [
          {
            id: "note:mem-confirmed",
            entityId: "mem-confirmed",
            type: "note",
            kind: "decision",
            trust: "high",
            confirmed: true,
            text: "Use the streaming parser.",
          },
          {
            id: "principal:human:founder",
            entityId: "human:founder",
            type: "principal",
            kind: "human",
            trust: "high",
          },
        ],
        edges: [
          {
            from: "note:mem-confirmed",
            to: "principal:human:founder",
            relation: "CONFIRMED_BY",
          },
        ],
        goal: "principal",
      },
      contradictions: [],
      provenance: {
        root: "note:mem-confirmed",
        hops: 6,
        relations: ["CONFIRMED_BY"],
        truncated: false,
        textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
      },
    });
    (window as unknown as { muon: unknown }).muon = {
      memoryExplain,
    };

    render(
      React.createElement(MemoryWorkspace, {
        snapshot,
        loading: false,
        error: null,
        query: "",
        onQueryChange: vi.fn(),
        onRefresh: vi.fn(),
        onDecide: vi.fn(),
      })
    );
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Use the streaming parser." })
    );

    expect(
      await screen.findByText("Why the brain believes this")
    ).toBeTruthy();
    expect(await screen.findByText("human:founder")).toBeTruthy();
    expect(memoryExplain).toHaveBeenCalledWith("mem-confirmed");
  });

  // ── B1 — the bounded neighbourhood ─────────────────────────────────────────
  //
  // `memory_neighbors` shipped backend-side and as an agent tool with no human
  // surface at all, so a capability MUON governs was invisible to its operator.
  // These pin the three things the surface must not get wrong: it renders, it
  // keeps a gated node coordinates-only, and a graph OUTAGE never renders as
  // "this note has no neighbours".

  const neighborsPayload = {
    nodes: [
      {
        id: "note:mem-confirmed",
        entityId: "mem-confirmed",
        type: "note",
        confirmed: true,
        text: "Use the streaming parser.",
      },
      {
        id: "module:src/parser.ts",
        entityId: "src/parser.ts",
        type: "module",
      },
      {
        id: "note:mem-proposal",
        entityId: "mem-proposal",
        type: "note",
        confirmed: false,
      },
    ],
    edges: [
      {
        from: "note:mem-confirmed",
        to: "module:src/parser.ts",
        relation: "ANCHORED_TO",
      },
      {
        from: "note:mem-proposal",
        to: "note:mem-confirmed",
        relation: "CONTRADICTS",
      },
    ],
    provenance: {
      root: "note:mem-confirmed",
      hops: 1,
      relations: ["ANCHORED_TO", "CONTRADICTS"],
      truncated: false,
      textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
    },
  };

  function openConfirmedNote() {
    render(
      React.createElement(MemoryWorkspace, {
        snapshot,
        loading: false,
        error: null,
        query: "",
        onQueryChange: vi.fn(),
        onRefresh: vi.fn(),
        onDecide: vi.fn(),
      })
    );
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Use the streaming parser." })
    );
  }

  it("renders the note's bounded neighbourhood, keeping a gated node coordinates-only", async () => {
    const memoryNeighbors = vi.fn().mockResolvedValue(neighborsPayload);
    (window as unknown as { muon: unknown }).muon = { memoryNeighbors };

    openConfirmedNote();

    expect(await screen.findByText("What this is connected to")).toBeTruthy();
    expect(memoryNeighbors).toHaveBeenCalledWith("mem-confirmed");
    // The root note itself is not a neighbour of itself.
    expect(screen.queryByText("ANCHORED_TO ·")).toBeTruthy();
    expect(screen.queryByText("CONTRADICTS ·")).toBeTruthy();
    const neighbourList = document.querySelector(".memory-neighbor-list")!;
    expect(neighbourList.textContent).toContain("src/parser.ts");
    expect(neighbourList.textContent).toContain("mem-proposal");
    expect(neighbourList.querySelectorAll("li")).toHaveLength(2);
    // The backend withheld the unconfirmed note's text; the renderer says so
    // rather than substituting the copy it happens to hold in the snapshot.
    expect(screen.getAllByText(/coordinates only/).length).toBeGreaterThan(0);
    expect(screen.getByText(/2 links · one hop out/)).toBeTruthy();
  });

  it("says the graph is UNAVAILABLE on a degraded read, never 'no neighbours'", async () => {
    const memoryNeighbors = vi.fn().mockResolvedValue({
      nodes: [],
      edges: [],
      provenance: {
        root: "note:mem-confirmed",
        hops: 1,
        relations: [],
        truncated: false,
        textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
      },
      degraded: {
        subsystem: "memory-graph",
        reason: "the mirror is rebuilding",
      },
    });
    (window as unknown as { muon: unknown }).muon = { memoryNeighbors };

    openConfirmedNote();

    expect(
      await screen.findByText(
        /The memory graph is unavailable \(the mirror is rebuilding\)/
      )
    ).toBeTruthy();
    expect(screen.queryByText("Nothing is linked to this note yet.")).toBeNull();
  });

  it("distinguishes a genuinely empty neighbourhood from an outage", async () => {
    (window as unknown as { muon: unknown }).muon = {
      memoryNeighbors: vi.fn().mockResolvedValue({
        nodes: [
          {
            id: "note:mem-confirmed",
            entityId: "mem-confirmed",
            type: "note",
          },
        ],
        edges: [],
        provenance: {
          root: "note:mem-confirmed",
          hops: 1,
          relations: [],
          truncated: false,
          textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
        },
      }),
    };

    openConfirmedNote();

    expect(
      await screen.findByText("Nothing is linked to this note yet.")
    ).toBeTruthy();
    expect(screen.queryByText(/memory graph is unavailable/)).toBeNull();
  });

  it("reports a rejected neighbourhood read instead of leaving a blank block", async () => {
    (window as unknown as { muon: unknown }).muon = {
      memoryNeighbors: vi.fn().mockRejectedValue(new Error("offline")),
    };

    openConfirmedNote();

    expect(
      await screen.findByText("The neighbourhood is unavailable for this note.")
    ).toBeTruthy();
  });
});

describe("neighborRows", () => {
  it("drops the root, annotates each neighbour with the relation that reached it", () => {
    expect(
      neighborRows({
        nodes: [
          { id: "note:a", entityId: "a", type: "note" },
          { id: "task:t1", entityId: "t1", type: "task" },
        ],
        edges: [{ from: "note:a", to: "task:t1", relation: "ABOUT_TASK" }],
        provenance: {
          root: "note:a",
          hops: 1,
          relations: ["ABOUT_TASK"],
          truncated: false,
          textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
        },
      })
    ).toEqual([
      { id: "task:t1", entityId: "t1", type: "task", relation: "ABOUT_TASK" },
    ]);
  });

  it("keeps a node the traversal returned with no edge to the root", () => {
    const rows = neighborRows({
      nodes: [
        { id: "note:a", entityId: "a", type: "note" },
        { id: "lane:claude", entityId: "claude", type: "lane" },
      ],
      edges: [],
      provenance: {
        root: "note:a",
        hops: 1,
        relations: [],
        truncated: false,
        textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relation).toBe("LINKED");
  });
});

// ── the two facts a reviewer needs are DIFFERENT facts ────────────────────────
//
// With `autoConfirmAgentMemory` ON (the default), an unconfirmed agent note reads
// "Auto · crew memory" — it is usable in its chat now. Model-mined notes ride
// that same posture, so the crew is already reading prose a MODEL wrote and no
// human has vouched for. "Usable now" does not say that; the provenance badge
// does, and it has to survive both postures because the review queue is where
// the human eventually looks.
describe("machine-extracted provenance", () => {
  const memoryNote = (over: Record<string, unknown>) => ({
    id: "mem-x",
    kind: "decision" as const,
    text: "Charges are idempotent by request key.",
    modules: ["src/pay/charge.ts"],
    topics: [],
    symbols: [],
    trust: "low" as const,
    confirmed: false,
    stale: false,
    status: "active" as const,
    scope: "project",
    createdBy: "muon-extractor",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    ...over,
  });

  const renderLibrary = (
    notes: Record<string, unknown>[],
    autoConfirmAgentMemory: boolean
  ) => {
    render(
      React.createElement(MemoryWorkspace, {
        snapshot: {
          ...snapshot,
          notes: notes as (typeof snapshot)["notes"],
          edges: [],
          confirmations: [],
          total: notes.length,
        },
        loading: false,
        error: null,
        query: "",
        onQueryChange: vi.fn(),
        onRefresh: vi.fn(),
        onDecide: vi.fn(),
        autoConfirmAgentMemory,
      })
    );
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
  };

  it("marks a crew-visible mined note machine-extracted while still calling it usable", () => {
    renderLibrary([memoryNote({ id: "mem-mined" })], true);
    // Both, not either: the posture says it is active, the badge says a model
    // wrote it. Losing the second is how "Auto · crew memory" starts reading
    // like "somebody approved this".
    expect(screen.getByText("Auto · crew memory")).toBeTruthy();
    expect(screen.getByText("Machine-extracted")).toBeTruthy();
  });

  it("does NOT mark an ordinary agent proposal — the badge is about authorship", () => {
    renderLibrary(
      [memoryNote({ id: "mem-agent", createdBy: "agent:codex" })],
      true
    );
    expect(screen.getByText("Auto · crew memory")).toBeTruthy();
    expect(screen.queryByText("Machine-extracted")).toBeNull();
  });

  it("drops the badge once a human confirms it — review is what the label tracks", () => {
    renderLibrary(
      [memoryNote({ id: "mem-mined-confirmed", confirmed: true })],
      true
    );
    expect(screen.queryByText("Machine-extracted")).toBeNull();
  });

  it("keeps the badge with the posture OFF, where the note sits in the review queue", () => {
    renderLibrary([memoryNote({ id: "mem-mined" })], false);
    expect(screen.getByText(/^Review needed/)).toBeTruthy();
    expect(screen.getByText("Machine-extracted")).toBeTruthy();
  });

  it("pins the renderer's principal literal to @muon/core (drift canary)", async () => {
    // The renderer is browser-safe and cannot import @muon/core (it reaches the
    // vendor CLI surface), so `muon-extractor` is MIRRORED — the same trade
    // `isHumanAuthored` makes against backend auth.ts. If this fails, @muon/core
    // renamed the extractor principal and this badge silently stopped matching
    // anything.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const core = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../packages/core/src/memory-extract-lane.ts"
      ),
      "utf8"
    );
    expect(core).toContain(
      `export const MEMORY_EXTRACTOR_PRINCIPAL = "muon-extractor";`
    );
    const renderer = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/memory-workspace.tsx"),
      "utf8"
    );
    expect(renderer).toContain(
      `const MEMORY_EXTRACTOR_PRINCIPAL = "muon-extractor";`
    );
  });
});

// P0-2 — the founder's screenshot: "Review inbox (24)", every card badged
// "Auto · crew memory" with Confirm/Reject and "Expires in 30 days". Those notes
// were already usable, so presenting them as a queue was presenting settled work
// as a debt. The orchestrator now vouches for them, and this tab says so.
describe("MemoryWorkspace — crew memory reads as a log, not a debt", () => {
  function vouchedNote(over: Record<string, unknown> = {}) {
    return {
      id: "mem-vouched",
      kind: "gotcha" as const,
      text: "The refund lane needs the idempotency key before it retries.",
      modules: ["src/billing/refund.ts"],
      topics: ["refund"],
      symbols: [],
      trust: "medium" as const,
      confirmed: false,
      confirmedBy: "orchestrator" as const,
      stale: false,
      status: "active" as const,
      scope: "project",
      createdBy: "agent:job:job-7",
      createdAt: "2026-07-16T01:00:00.000Z",
      updatedAt: "2026-07-16T01:00:00.000Z",
      expiresAt: null,
      ...over,
    };
  }

  function renderWith(notes: unknown[], onDecide = vi.fn()) {
    render(
      React.createElement(MemoryWorkspace, {
        snapshot: { ...snapshot, notes, total: notes.length },
        loading: false,
        error: null,
        query: "",
        autoConfirmAgentMemory: true,
        onQueryChange: vi.fn(),
        onRefresh: vi.fn(),
        onDecide,
      } as unknown as Parameters<typeof MemoryWorkspace>[0])
    );
    return { onDecide };
  }

  it("does NOT count vouched crew memory as work the operator owes", () => {
    renderWith([vouchedNote(), vouchedNote({ id: "mem-vouched-2" })]);
    // The tab badge is a DEBT counter: no bare "(2)" for settled knowledge.
    const tab = screen.getByRole("tab", { name: /crew memory/i });
    expect(tab.textContent).toBe("Crew memory");
    expect(screen.queryByRole("tab", { name: /review inbox/i })).toBeNull();
    // …and no "Needs you" band at all when nothing does.
    expect(screen.queryByText("Needs you")).toBeNull();
  });

  it("shows them as what the crew learned, and says nothing is waiting on you", () => {
    renderWith([vouchedNote()]);
    expect(screen.getByText("What the crew learned")).toBeTruthy();
    expect(
      screen.getByText(/nothing here is waiting on you/i)
    ).toBeTruthy();
    // The note itself is still fully visible — this is a log, not a hidden pile.
    expect(
      screen.getByText(/refund lane needs the idempotency key/i)
    ).toBeTruthy();
  });

  it("names WHO vouched — MUON's confirm is visibly weaker than the human's", () => {
    renderWith([
      vouchedNote(),
      vouchedNote({
        id: "mem-human",
        text: "A fact a person actually signed off.",
        confirmed: true,
        confirmedBy: "human",
      }),
    ]);
    // The crew log carries MUON's vouch…
    expect(screen.getByText(/Auto-approved by MUON . crew memory/)).toBeTruthy();
    // …and a human confirm reads as the stronger, personally-attributed tier
    // (it graduates out of the log into the durable Library, as it always has).
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByText(/Confirmed by you . medium evidence/)).toBeTruthy();
  });

  // ── P0-3 — THE asymmetry ───────────────────────────────────────────────────
  //
  // Quiet was not enough. A pair of actions where one of them says "Confirm" IS
  // a review queue, whatever the header says above it: the founder read the row
  // of Confirm buttons as "memory is still asking me to approve things" — the
  // third time on this theme — and they were right. A settled note is a fact the
  // crew is already using, so the card offers NO confirm affordance at all. Only
  // Reject survives, because a wrong memory must still be killable.
  it("offers NO confirm affordance on a settled card — Reject is the only action", () => {
    renderWith([vouchedNote(), vouchedNote({ id: "mem-vouched-2" })]);
    // Not "quiet confirm" — ABSENT. Nothing matching /confirm/ is clickable.
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
    expect(screen.queryByText("Confirm it yourself")).toBeNull();
    const rejects = screen.getAllByRole("button", { name: "Reject" });
    expect(rejects).toHaveLength(2);
    // …and the one surviving action is visually quiet: nothing is emphasized,
    // because nothing is being asked.
    for (const reject of rejects) {
      expect(reject.className).toContain("ghost-btn");
      expect(reject.className).not.toContain("primary-btn");
    }
    // The whole tab is free of primary buttons when everything is vouched.
    expect(
      document.querySelectorAll(".memory-card-grid .primary-btn")
    ).toHaveLength(0);
  });

  it("DOES ask on a genuinely unvouched note — Confirm is primary there", () => {
    renderWith([vouchedNote({ id: "mem-open", confirmedBy: null })]);
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm.className).toContain("primary-btn");
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  // The asymmetry in ONE render: an unvouched note asks, the settled one beside
  // it does not. Exactly one Confirm on screen, and it belongs to the pending
  // note in the "Needs you" band.
  it("asks on the unvouched note and stays silent on the settled one, side by side", () => {
    renderWith([
      vouchedNote(),
      vouchedNote({
        id: "mem-open",
        text: "Nobody has vouched for this one.",
        confirmedBy: null,
      }),
    ]);
    const confirms = screen.getAllByRole("button", { name: /confirm/i });
    expect(confirms).toHaveLength(1);
    const asking = confirms[0]!.closest("article");
    expect(asking?.textContent).toContain("Nobody has vouched for this one.");
    const settledCard = screen
      .getByText(/refund lane needs the idempotency key/i)
      .closest("article")!;
    expect(
      within(settledCard).queryByRole("button", { name: /confirm/i })
    ).toBeNull();
    expect(within(settledCard).getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("still lets the founder kill a wrong settled memory", () => {
    const { onDecide } = renderWith([vouchedNote()]);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onDecide).toHaveBeenCalledWith("mem-vouched", "reject");
  });

  // The human confirm is NOT deleted — it is the tier that unlocks global-scope
  // promotion, pack export, KG-6 protection and merge attestation — it moved to
  // the Library, where reaching for a note IS the intent to promote it. And it
  // is now "Promote", LAST in the action row: the founder read a leading
  // "Confirm to promote" as a demanded review three missions running.
  it("keeps the human confirm on the Library — trailing, and never verbed as a review", () => {
    const { onDecide } = renderWith([vouchedNote()]);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
    const promote = screen.getByRole("button", { name: "Promote" });
    // Quiet even here: the Library offers it, it never asks for it.
    expect(promote.className).toContain("ghost-btn");
    expect(promote.className).not.toContain("primary-btn");
    expect(promote.getAttribute("title")).toMatch(/global scope/);
    // Last in its row — an offer trails, an ask leads.
    const row = promote.closest(".memory-decision-actions");
    const buttons = Array.from(row?.querySelectorAll("button") ?? []);
    expect(buttons[buttons.length - 1]).toBe(promote);
    fireEvent.click(promote);
    expect(onDecide).toHaveBeenCalledWith("mem-vouched", "confirm");
  });

  // The Library is where PROMOTION lives, not a second review queue: a note
  // nobody has vouched for is adjudicated in the "Needs you" band, with both
  // actions, and the shelf stays free of one-sided asks.
  it("does not turn the Library into a second queue for unvouched notes", () => {
    renderWith([vouchedNote({ id: "mem-open", confirmedBy: null })]);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("never offers to re-confirm what a human already confirmed", () => {
    renderWith([
      vouchedNote({
        id: "mem-human",
        text: "A fact a person actually signed off.",
        confirmed: true,
        confirmedBy: "human",
      }),
    ]);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  // F14a — the Graph tab's dense table had its own tier string and still read
  // "pending" for a MUON-vouched note. "Pending" is a debt word, and this is the
  // same string class that produced the thirteen-clicks symptom on the cards.
  it("the Graph table names the vouched tier instead of calling it pending", () => {
    renderWith([
      vouchedNote({ text: "MUON approved this one." }),
      vouchedNote({
        id: "mem-open",
        text: "Nobody has vouched for this one.",
        confirmedBy: null,
      }),
      vouchedNote({
        id: "mem-mine",
        text: "A person signed this one.",
        confirmed: true,
        confirmedBy: "human",
      }),
    ]);
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    const pendingCells = () =>
      Array.from(screen.getByRole("table").querySelectorAll("td")).filter(
        (cell) => cell.textContent?.includes("pending")
      );

    // DEFAULT view: the crew's working memory is ALL THREE tiers, each named
    // for what it is, and nothing here is a debt — under the posture, the
    // unvouched agent note is crew-visible "auto", never "pending".
    expect(screen.getByRole("table").textContent).toContain("muon-approved");
    expect(screen.getByRole("table").textContent).toContain("trusted");
    expect(screen.getByRole("table").textContent).toContain("auto · crew");
    expect(pendingCells()).toHaveLength(0);

    // Nothing genuinely open exists in this fixture, so the toggle adds none.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include pending proposals" })
    );
    expect(pendingCells()).toHaveLength(0);
  });

  // A lapsed note is the ONE thing the posture cannot carry: nothing vouches
  // for it now, so it is genuinely pending — hidden by default, revealed (and
  // named "pending") by the toggle.
  it("the toggle reveals a LAPSED note as pending, posture notwithstanding", () => {
    renderWith([
      vouchedNote(),
      vouchedNote({
        id: "mem-lapsed",
        text: "This vouch lapsed and nothing carries it now.",
        confirmedBy: null,
        expired: true,
      }),
    ]);
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(
      screen.queryByText("This vouch lapsed and nothing carries it now.")
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include pending proposals" })
    );
    const table = screen.getByRole("table");
    expect(table.textContent).toContain(
      "This vouch lapsed and nothing carries it now."
    );
    expect(table.textContent).toContain("pending");
  });

  // The same fix one level up: the graph's DEFAULT view filed every
  // MUON-vouched note under "pending proposals", hiding the crew's own settled,
  // in-use knowledge behind a checkbox.
  it("shows vouched crew memory in the graph by default, not behind the toggle", () => {
    renderWith([vouchedNote({ text: "Settled and in use by the crew." })]);
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(screen.getByText("In crew use")).toBeTruthy();
    expect(
      screen.getByRole("table").textContent
    ).toContain("Settled and in use by the crew.");
  });

  // P0-3 — ONE note, ONE name. The node inspector called a MUON-vouched note
  // "Auto · crew" (the weaker, merely-crew-VISIBLE tier) while the Crew-memory
  // tab called the same note "Auto-approved by MUON" and this tab's own table
  // called it "muon-approved". Two tabs, two stories.
  it("the Graph inspector names the same tier the Crew tab does", () => {
    renderWith([vouchedNote({ text: "Settled and in use by the crew." })]);
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Settled and in use by the crew." })
    );
    const detail = document.querySelector(".memory-graph-detail")!;
    expect(within(detail as HTMLElement).getByText("Auto-approved by MUON")).toBeTruthy();
    expect(within(detail as HTMLElement).queryByText("Auto · crew")).toBeNull();
    expect(within(detail as HTMLElement).queryByText("Review needed")).toBeNull();
  });

  // The posture line and the table cells are derived from the same tier, so the
  // Graph tab can never claim a settled note is pending in one place and not the
  // other — nor disagree with the Crew tab's debt badge.
  it("counts settled and pending the same way the table labels them", () => {
    renderWith([
      vouchedNote(),
      vouchedNote({
        id: "mem-open",
        text: "Nobody has vouched for this one.",
        confirmedBy: null,
      }),
    ]);
    // Crew tab: exactly one debt.
    expect(
      screen.getByRole("tab", { name: /crew memory/i }).textContent
    ).toBe("Crew memory (1)");

    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    // Under the posture, the unvouched note is crew-visible AUTO — in the
    // default view, counted by its own name, never "pending".
    expect(screen.getByText("1 settled · 1 auto · 0 pending")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include pending proposals" })
    );
    // Nothing genuinely open exists here, so the counts do not move.
    expect(screen.getByText("1 settled · 1 auto · 0 pending")).toBeTruthy();
  });

  // F14c — the inbox count is derived CLIENT-SIDE from rows already fetched, so
  // it never renders a server `total` over the "unconfirmed" bucket. Pinned
  // because the alternative (asking the server per load) is the second full
  // fetch the library loader deliberately refuses to make.
  it("derives the debt count from the rows in hand, not from a server total", () => {
    render(
      React.createElement(MemoryWorkspace, {
        // A deliberately WRONG server total: if the badge read it, this fails.
        snapshot: {
          ...snapshot,
          notes: [vouchedNote(), vouchedNote({ id: "mem-2" })],
          total: 99,
        },
        loading: false,
        error: null,
        query: "",
        autoConfirmAgentMemory: true,
        onQueryChange: vi.fn(),
        onRefresh: vi.fn(),
        onDecide: vi.fn(),
      } as unknown as Parameters<typeof MemoryWorkspace>[0])
    );
    expect(
      screen.getByRole("tab", { name: /crew memory/i }).textContent
    ).toBe("Crew memory");
  });

  // Standing consent (Full Auto / per-lane auto-approve) is the loudest,
  // most deliberate control in the app. With it armed, an unvouched but
  // crew-VISIBLE note is not a debt: the operator explicitly delegated routine
  // decisions, and MUON asking anyway is the friction they turned off. The
  // note's TRUST is untouched — it is still unconfirmed and still cannot gate
  // an edit; only which of the two reading surfaces it lands on changes.
  it("standing consent moves crew-visible notes out of the debt queue", () => {
    render(
      React.createElement(MemoryWorkspace, {
        snapshot: {
          ...snapshot,
          notes: [
            vouchedNote({
              id: "mem-auto",
              text: "Crew-visible, nobody vouched.",
              confirmedBy: null,
            }),
          ],
          total: 1,
        },
        loading: false,
        error: null,
        query: "",
        autoConfirmAgentMemory: true,
        standingConsent: true,
        onQueryChange: vi.fn(),
        onRefresh: vi.fn(),
        onDecide: vi.fn(),
      } as unknown as Parameters<typeof MemoryWorkspace>[0])
    );
    // No debt badge, no exception band — it reads as settled crew knowledge.
    expect(
      screen.getByRole("tab", { name: /crew memory/i }).textContent
    ).toBe("Crew memory");
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(screen.getByText("Crew-visible, nobody vouched.")).toBeTruthy();
    // …and the CARD itself does not ask either: the card's private
    // settled-rule had drifted (tier === "muon" only), so a note the section
    // header called "already working from" still wore a primary Confirm —
    // the founder read it as demanded review, three screenshots running.
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    // Reject stays one click away — a wrong note must always be killable.
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("without standing consent the same note is still a debt (no silent widening)", () => {
    renderWith([
      vouchedNote({
        id: "mem-auto-strict",
        text: "Crew-visible, nobody vouched.",
        confirmedBy: null,
      }),
    ]);
    expect(
      screen.getByRole("tab", { name: /crew memory/i }).textContent
    ).toBe("Crew memory (1)");
    expect(screen.getByText("Needs you")).toBeTruthy();
  });

  it("still puts a genuinely unvouched note in front of the human", () => {
    renderWith([
      vouchedNote(),
      vouchedNote({
        id: "mem-unvouched",
        text: "Nobody has vouched for this one.",
        confirmedBy: null,
      }),
    ]);
    const tab = screen.getByRole("tab", { name: /crew memory/i });
    expect(tab.textContent).toBe("Crew memory (1)");
    // It lands in the exception band, and is NOT described as vouched.
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("Nobody has vouched for this one.")).toBeTruthy();
    expect(screen.getAllByText(/Auto-approved by MUON/)).toHaveLength(1);
  });

  it("hands an EXPIRED note back to the human — nobody is vouching for it now", () => {
    renderWith([
      vouchedNote({
        id: "mem-lapsed",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        expired: true,
      }),
    ]);
    const tab = screen.getByRole("tab", { name: /crew memory/i });
    expect(tab.textContent).toBe("Crew memory (1)");
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.queryByText(/Auto-approved by MUON/)).toBeNull();
  });
});

// ── ADR-0026 §9 — the desktop LABELS its partition ───────────────────────────
//
// The desktop was already fenced, by accident: `main.ts` overrides any caller
// `chatId` with the bound chat, and `OrchestratorChat.workspacePath` is NOT NULL, so
// a chat lives in exactly one workspace. §9 therefore asks for a LABEL here, not a
// fence — plus §6's hole closed, which `main.ts` does by forcing `workspace` too.
//
// The label is derived from the ROWS the server returned rather than echoed from the
// request, so it is a check as well as a label: a fence regression shows up as a
// second entry instead of the page quietly mixing two repos.
describe("MemoryWorkspace — ADR-0026 workspace label", () => {
  const inA = { ...snapshot.notes[0]!, workspacePath: "/Users/dev/SWE/repo-a" };

  it("states the single workspace the page is showing", () => {
    render(
      React.createElement(MemoryWorkspace, {
        snapshot: { ...snapshot, notes: [inA], total: 1 },
        loading: false,
        error: null,
        query: "",
        onQueryChange: () => {},
        onRefresh: () => {},
        onDecide: () => {},
      })
    );
    expect(screen.getByText("/Users/dev/SWE/repo-a")).toBeTruthy();
    expect(screen.queryByText(/spans more than one workspace/)).toBeNull();
  });

  it("labels an unassigned note as the §8 residue rather than blank", () => {
    render(
      React.createElement(MemoryWorkspace, {
        snapshot: {
          ...snapshot,
          notes: [{ ...snapshot.notes[0]!, workspacePath: null }],
          total: 1,
        },
        loading: false,
        error: null,
        query: "",
        onQueryChange: () => {},
        onRefresh: () => {},
        onDecide: () => {},
      })
    );
    expect(screen.getByText("unscoped")).toBeTruthy();
  });

  it("SAYS SO when a page spans two workspaces — the fence makes this impossible", () => {
    // This is the measured §1 defect rendered honestly. It should be unreachable
    // through the desktop after step 4; if it ever happens the operator sees it
    // rather than reading two repos' memory as one.
    render(
      React.createElement(MemoryWorkspace, {
        snapshot: {
          ...snapshot,
          notes: [
            inA,
            { ...snapshot.notes[1]!, workspacePath: "/Users/dev/SWE/repo-b" },
          ],
        },
        loading: false,
        error: null,
        query: "",
        onQueryChange: () => {},
        onRefresh: () => {},
        onDecide: () => {},
      })
    );
    expect(screen.getByText("/Users/dev/SWE/repo-a")).toBeTruthy();
    expect(screen.getByText("/Users/dev/SWE/repo-b")).toBeTruthy();
    expect(screen.getByText(/spans more than one workspace/)).toBeTruthy();
  });
});
