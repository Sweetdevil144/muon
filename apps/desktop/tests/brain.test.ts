// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConvergencePreflight } from "@muon/client/convergence-preflight";
import {
  buildPreEditView,
  type PreEditContext,
} from "@muon/client/preedit-view";
import { BrainContent, EvidencePanel, MemoryPanel } from "../src/renderer/brain.js";

const contextFixture: PreEditContext = {
  target: {
    module: "src/auth/guard.ts",
    symbol: "src/auth/guard.ts#authorize",
  },
  blastRadius: {
    modules: ["src/auth/guard.ts", "src/auth/session.ts"],
    symbols: ["src/auth/guard.ts#authorize"],
    depth: 1,
    source: "provided",
  },
  memories: [
    {
      id: "memory-1",
      taskId: null,
      laneId: null,
      kind: "decision",
      text: "Authorization stays deny-by-default.",
      modules: ["src/auth/guard.ts"],
      topics: ["authorization"],
      symbols: ["src/auth/guard.ts#authorize"],
      trust: "high",
      confirmed: true,
      stale: false,
      status: "active",
      createdBy: "human:operator",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      proximity: 1,
      onTarget: true,
      onSymbol: true,
    },
  ],
  warnings: [],
  pendingProposals: [
    {
      proposalNoteId: "proposal-1",
      victimNoteId: "memory-1",
      modules: ["src/auth/guard.ts"],
      detail: "An unconfirmed proposal contests a governed decision.",
    },
  ],
  activity: [],
  duplicateWork: [],
};

type BrainContentProps = Parameters<typeof BrainContent>[0];
type BrainBridge = Pick<
  Window["muon"],
  "preEditContext" | "getMemoryNote" | "updateMemoryNote" | "autoContext"
>;
type MemoryNote = Awaited<ReturnType<Window["muon"]["getMemoryNote"]>>;

function makeBrainContentProps(
  overrides: Partial<BrainContentProps> = {}
): BrainContentProps {
  const view = buildPreEditView(contextFixture);
  return {
    view,
    preflight: buildConvergencePreflight({
      view,
      intent: { vendor: "claude-code", action: "ultrareview" },
      authority: { principal: "human" },
    }),
    proposalText: {},
    acting: null,
    onViewProposal: async () => undefined,
    onAdjudicate: async () => undefined,
    ...overrides,
  };
}

function contextFor(
  target: string,
  memoryText: string,
  pendingProposal = true
): PreEditContext {
  const symbol = `${target}#authorize`;
  const memoryId = `memory:${target}`;
  return {
    ...contextFixture,
    target: { module: target, symbol },
    blastRadius: {
      modules: [target],
      symbols: [symbol],
      depth: 1,
      source: "provided",
    },
    memories: [
      {
        ...contextFixture.memories[0]!,
        id: memoryId,
        text: memoryText,
        modules: [target],
        symbols: [symbol],
      },
    ],
    pendingProposals: pendingProposal
      ? [
          {
            ...contextFixture.pendingProposals[0]!,
            victimNoteId: memoryId,
            modules: [target],
          },
        ]
      : [],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installBrainBridge(overrides: Partial<BrainBridge> = {}): BrainBridge {
  const memory = contextFixture.memories[0]!;
  const bridge: BrainBridge = {
    dataBoundaries: vi.fn(async () => ({ status: "degraded", reason: "not under test" })),
    preEditContext: vi.fn(async () => contextFixture),
    getMemoryNote: vi.fn(async () => memory),
    updateMemoryNote: vi.fn(async () => memory),
    autoContext: vi.fn(async () => null),
    ...overrides,
  };
  Object.defineProperty(window, "muon", {
    configurable: true,
    writable: true,
    value: bridge as Window["muon"],
  });
  return bridge;
}

async function submitTarget(
  user: ReturnType<typeof userEvent.setup>,
  target: string
): Promise<void> {
  const input = screen.getByPlaceholderText(
    /Filter evidence/
  ) as HTMLInputElement;
  await user.clear(input);
  await user.type(input, target);
  const form = input.closest("form");
  if (!form) {
    throw new Error("Brain target form not found.");
  }
  fireEvent.submit(form);
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "muon");
  vi.clearAllMocks();
});

describe("desktop BrainContent", () => {
  it("renders the convergence review in plain-language contract order", () => {
    const html = renderToStaticMarkup(
      React.createElement(BrainContent, makeBrainContentProps())
    );

    expect(html.indexOf("Intent")).toBeLessThan(html.indexOf("Evidence"));
    expect(html.indexOf("Evidence")).toBeLessThan(
      html.indexOf("Coordination")
    );
    expect(html.indexOf("Coordination")).toBeLessThan(
      html.indexOf("Control")
    );
    expect(html).toContain("Review needed");
    expect(html).toContain("claude-code");
    expect(html).toContain("/ultrareview");
    expect(html).toContain("Authorization stays deny-by-default.");
    expect(html).toContain("View proposal");
    expect(html).toContain("Confirm");
    expect(html).toContain("Reject");
  });

  it("withholds proposal note text until it is explicitly supplied", () => {
    const proposalNoteText = "Replace deny-by-default with allow-by-default.";
    const hiddenHtml = renderToStaticMarkup(
      React.createElement(BrainContent, makeBrainContentProps())
    );
    const revealedHtml = renderToStaticMarkup(
      React.createElement(
        BrainContent,
        makeBrainContentProps({
          proposalText: { "proposal-1": proposalNoteText },
        })
      )
    );

    expect(hiddenHtml).not.toContain(proposalNoteText);
    expect(revealedHtml).toContain(proposalNoteText);
  });

  // Brain-gate side-channel invariant (docs/MEMORY.md): the confirmed-only
  // gate must cover EVERY content-bearing field. Task #130 default-expands
  // the evidence list (no cap, no "N more omitted") — this HOLDS THE LINE
  // that default-expand only means "show every TRUSTED row"; it must never
  // auto-reveal an UNTRUSTED note's text, even though the row itself (its
  // chip/label) is now always visible.
  it("HOLD THE LINE: default-expand shows every evidence row, but an untrusted row's detail text stays gated", () => {
    const props = makeBrainContentProps();
    const evidenceRows = Array.from({ length: 8 }, (_, index) => ({
      id: `evidence-row-${index + 1}`,
      label: `Evidence row ${index + 1}`,
      severity: "info" as const,
      // Only row 1 is TRUSTED (a confirmed, on-target/on-symbol note) — every
      // other row is an untrusted/unconfirmed neighbour. `detail` carries
      // text in EVERY row (mirrors the real shape), so this isolates the
      // render guard (`row.trustedText && row.detail`, brain.tsx) — it must
      // gate on trust, never merely on whether `detail` is present.
      trustedText: index === 0,
      detail: `Secret memory text ${index + 1}.`,
    }));

    render(
      React.createElement(BrainContent, {
        ...props,
        preflight: {
          ...props.preflight,
          evidence: {
            ...props.preflight.evidence,
            count: evidenceRows.length,
            rows: evidenceRows,
          },
        },
      })
    );

    // Default-expand: every row's label/chip renders — no cap, no omission.
    for (let index = 1; index <= 8; index += 1) {
      expect(screen.getByText(`Evidence row ${index}`)).toBeTruthy();
    }
    expect(screen.queryByText(/more evidence/)).toBeNull();

    // HOLD THE LINE: only the ONE trusted row's text is shown; every
    // untrusted row's detail stays gated even though its row is visible.
    expect(screen.getByText("Secret memory text 1.")).toBeTruthy();
    for (let index = 2; index <= 8; index += 1) {
      expect(screen.queryByText(`Secret memory text ${index}.`)).toBeNull();
    }
  });

  it("uses labelled semantic headings for every convergence section", () => {
    render(React.createElement(BrainContent, makeBrainContentProps()));

    for (const title of ["Intent", "Evidence", "Coordination", "Control"]) {
      const heading = screen.getByRole("heading", { name: title, level: 2 });
      const section = heading.closest("section");
      expect(section).not.toBeNull();
      expect(section?.getAttribute("aria-labelledby")).toBe(heading.id);
    }
  });

  it("requires successfully loaded proposal text before adjudication", async () => {
    const user = userEvent.setup();
    const proposalNoteText = "Replace deny-by-default with allow-by-default.";
    const onViewProposal = vi.fn(
      async (_proposalNoteId: string): Promise<void> => undefined
    );
    const onAdjudicate = vi.fn(
      async (
        _proposalNoteId: string,
        _decision: "confirm" | "reject"
      ): Promise<void> => undefined
    );
    const props = makeBrainContentProps({ onViewProposal, onAdjudicate });
    const { rerender } = render(React.createElement(BrainContent, props));

    const initialViewButton = screen.getByRole("button", {
      name: "View proposal",
    }) as HTMLButtonElement;
    expect(initialViewButton.disabled).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Confirm",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Reject",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    await user.click(initialViewButton);
    expect(onViewProposal).toHaveBeenCalledWith("proposal-1");

    rerender(
      React.createElement(BrainContent, {
        ...props,
        proposalText: { "proposal-1": "…" },
      })
    );

    expect(
      (
        screen.getByRole("button", {
          name: "Confirm",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Reject",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);

    rerender(
      React.createElement(BrainContent, {
        ...props,
        proposalText: { "proposal-1": proposalNoteText },
      })
    );

    expect(screen.getByText(proposalNoteText)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "View proposal",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Confirm",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Reject",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onAdjudicate).toHaveBeenNthCalledWith(
      1,
      "proposal-1",
      "confirm"
    );
    expect(onAdjudicate).toHaveBeenNthCalledWith(
      2,
      "proposal-1",
      "reject"
    );
  });

  it("durably RETIRES a note on proposal reject — sends status:\"rejected\", not just confirmed:false", async () => {
    // Parity with CLI + TUI: `confirmed:false` alone records the governed reject
    // but leaves the note active, so it re-surfaces in recall — an operator-facing
    // lie. The reject must also carry status:"rejected" to retire it.
    const user = userEvent.setup();
    const target = "src/reject-payload.ts";
    const context = contextFor(target, "Proposal gate context.");
    const proposalNote = { ...context.memories[0]!, id: "proposal-1" };
    const updateMemoryNote = vi.fn(async () => proposalNote);
    installBrainBridge({
      dataBoundaries: vi.fn(async () => ({ status: "degraded", reason: "not under test" })),
      preEditContext: vi.fn(async () => context),
      getMemoryNote: vi.fn(async () => proposalNote),
      updateMemoryNote,
    });
    render(React.createElement(EvidencePanel, {}));

    await submitTarget(user, target);
    await screen.findByText("Proposal gate context.");
    await user.click(screen.getByRole("button", { name: "View proposal" }));
    const reject = await screen.findByRole("button", { name: "Reject" });
    await waitFor(() =>
      expect((reject as HTMLButtonElement).disabled).toBe(false)
    );
    await user.click(reject);

    await waitFor(() => expect(updateMemoryNote).toHaveBeenCalled());
    expect(updateMemoryNote.mock.calls.at(-1)![0]).toMatchObject({
      confirmed: false,
      status: "rejected",
      principal: "human",
    });
  });

  // Task #130 — default-expand evidence. Evidence now lives in a full-height
  // workspace tab (not a cramped modal), so every module/symbol/evidence/
  // coordination row renders — no numeric cap, no "N more omitted" line.
  it("renders every module and symbol coordinate with no cap, target symbol pinned first", () => {
    const modules = Array.from(
      { length: 8 },
      (_, index) => `src/evidence/module-${index + 1}.ts`
    );
    const symbols = Array.from(
      { length: 8 },
      (_, index) => `${modules[0]}#symbol${index + 1}`
    );
    const targetSymbol = symbols[7]!;
    const view = buildPreEditView({
      ...contextFixture,
      target: {
        module: modules[0],
        symbol: targetSymbol,
      },
      blastRadius: {
        modules,
        symbols,
        depth: 1,
        source: "provided",
      },
    });
    render(
      React.createElement(
        BrainContent,
        makeBrainContentProps({
          view,
          preflight: buildConvergencePreflight({
            view,
            authority: { principal: "human" },
          }),
        })
      )
    );

    const moduleList = screen.getByLabelText("Blast-radius modules");
    for (const modulePath of modules) {
      expect(within(moduleList).getByText(modulePath)).toBeTruthy();
    }

    const symbolList = screen.getByLabelText("Blast-radius symbols");
    for (const symbol of symbols) {
      expect(within(symbolList).getByText(symbol)).toBeTruthy();
    }
    // The target symbol is de-duplicated and pinned to the FIRST item.
    const symbolItems = within(symbolList).getAllByRole("listitem");
    expect(symbolItems).toHaveLength(symbols.length);
    expect(within(symbolItems[0]!).getByText(targetSymbol)).toBeTruthy();

    expect(screen.queryByText(/more module/)).toBeNull();
    expect(screen.queryByText(/more symbol/)).toBeNull();
  });

  it("renders every governed evidence and coordination row with no cap", () => {
    const memories = Array.from({ length: 8 }, (_, index) => ({
      ...contextFixture.memories[0]!,
      id: `memory-${index + 1}`,
      text: `Governed evidence ${index + 1}.`,
      symbols:
        index === 7
          ? ["src/auth/guard.ts#authorize"]
          : [`src/auth/neighbor-${index + 1}.ts#helper`],
      onTarget: index === 7,
      onSymbol: index === 7,
      proximity: index === 7 ? 1 : 2,
    }));
    const view = buildPreEditView({
      ...contextFixture,
      memories,
    });
    const preflight = buildConvergencePreflight({
      view,
      authority: { principal: "human" },
    });
    const coordinationRows = Array.from({ length: 8 }, (_, index) => ({
      id: `activity:${index + 1}`,
      label: `Coordination coordinate ${index + 1}`,
      severity: index === 0 ? ("warning" as const) : ("info" as const),
      trustedText: false,
    }));

    render(
      React.createElement(
        BrainContent,
        makeBrainContentProps({
          view,
          preflight: {
            ...preflight,
            coordination: {
              ...preflight.coordination,
              count: coordinationRows.length,
              rows: coordinationRows,
            },
          },
        })
      )
    );

    for (let index = 1; index <= 8; index += 1) {
      expect(screen.getByText(`Governed evidence ${index}.`)).toBeTruthy();
    }
    expect(screen.queryByText(/more evidence/)).toBeNull();

    for (let index = 1; index <= 8; index += 1) {
      expect(
        screen.getByText(`Coordination coordinate ${index}`)
      ).toBeTruthy();
    }
    expect(screen.queryByText(/more coordination/)).toBeNull();
  });

  it("prioritizes warning coordination rows before others, rendering every row (no cap)", () => {
    const props = makeBrainContentProps();
    const neighbourRows = Array.from({ length: 7 }, (_, index) => ({
      id: `activity:neighbour-${index + 1}`,
      label: `Neighbour coordinate ${index + 1}`,
      severity: "info" as const,
      trustedText: false,
    }));
    const coordinationRows = [
      ...neighbourRows.slice(0, 6),
      {
        id: "activity:exact-target",
        label: "Exact-target collision",
        severity: "warning" as const,
        trustedText: false,
      },
      {
        id: "duplicate:warning",
        label: "Duplicate-work collision",
        severity: "warning" as const,
        trustedText: false,
      },
      neighbourRows[6]!,
    ];

    render(
      React.createElement(BrainContent, {
        ...props,
        preflight: {
          ...props.preflight,
          coordination: {
            ...props.preflight.coordination,
            count: coordinationRows.length,
            rows: coordinationRows,
          },
        },
      })
    );

    const coordinationSection = screen
      .getByRole("heading", { name: "Coordination" })
      .closest("section");
    expect(coordinationSection).not.toBeNull();
    const visibleLabels = Array.from(
      coordinationSection!.querySelectorAll(".convergence-row")
    ).map((row) => row.lastElementChild?.textContent);

    expect(visibleLabels).toEqual([
      "Exact-target collision",
      "Duplicate-work collision",
      "Neighbour coordinate 1",
      "Neighbour coordinate 2",
      "Neighbour coordinate 3",
      "Neighbour coordinate 4",
      "Neighbour coordinate 5",
      "Neighbour coordinate 6",
      "Neighbour coordinate 7",
    ]);
    expect(screen.queryByText(/more coordination/)).toBeNull();
  });

  it("keeps the desktop layout responsive and long coordinates wrappable", () => {
    const styles = readFileSync("src/renderer/styles.css", "utf8");

    // Task #130: the old modal's fixed-width `.brain-card` is retired —
    // EvidencePanel/MemoryPanel now inherit the FULL center-column height via
    // `.workspace-panel-shell` (a genuine flex column) + `.workspace-panel-scroll`
    // (the actual scroll region), not an 88vh-capped dialog.
    expect(styles).toMatch(
      /\.workspace-panel-shell\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1;[^}]*flex-direction:\s*column;/
    );
    expect(styles).toMatch(
      /\.workspace-panel-scroll\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/
    );
    expect(styles).toContain("@media (max-width: 680px)");
    expect(styles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*?\.convergence-grid\s*\{[^}]*grid-template-columns: 1fr;/
    );
    expect(styles).toMatch(
      /\.convergence-section-summary,[\s\S]*?\.convergence-chips \.brain-chip\s*\{[^}]*overflow-wrap: anywhere;/
    );
  });
});

// Task #130: BrainPanel (the cramped modal with its own internal Evidence/
// Memory tab strip) is RETIRED. Evidence and Memory are now separate,
// independently-mounted CENTER workspace tabs (EvidencePanel / MemoryPanel —
// app.tsx renders whichever one is active); the old modal-chrome tests
// (accessible dialog, focus trap, Escape, "defaults to the Evidence tab")
// no longer apply — there is no modal, and no internal tab switch to default.
// EvidencePanel's own request-fencing / adjudication-gate tests below are
// the direct continuation of BrainPanel's old ones, unchanged in substance
// (useBrainState carries the exact same state/IPC — see brain.tsx).
describe("desktop EvidencePanel / MemoryPanel (workspace tabs, task #130)", () => {
  it("MemoryPanel loads the library on mount and renders the Memory workspace", async () => {
    const bridge = installBrainBridge();
    bridge.memoryLibrary = vi.fn(async () => ({
      notes: [],
      edges: [],
      confirmations: [],
      imports: [],
      total: 0,
      truncated: false,
    }));
    render(React.createElement(MemoryPanel, { chatId: "chat-a" }));

    expect(await screen.findByLabelText("Memory workspace")).toBeTruthy();
    expect(bridge.memoryLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-a" })
    );
    // MemoryPanel never renders the Evidence search form — that's
    // EvidencePanel's own, separately-mounted surface.
    expect(screen.queryByPlaceholderText(/Filter evidence/)).toBeNull();
  });

  // F5: standing consent is a PROP fed from app.tsx's live polled state, not a
  // one-shot getState() read. The old read went stale the moment the operator
  // changed the setting with the panel mounted — flipping consent OFF left the
  // most consent-sensitive surface still presenting unvouched notes as
  // settled. A rerender with the new value must move the note between the two
  // reading surfaces immediately.
  it("tracks standing consent LIVE — a prop change re-sorts the queue", async () => {
    const bridge = installBrainBridge();
    (bridge as Record<string, unknown>).getAutoConfirmAgentMemory = vi.fn(
      async () => true
    );
    bridge.memoryLibrary = vi.fn(async () => ({
      notes: [
        {
          id: "mem-auto-live",
          kind: "gotcha",
          text: "Crew-visible, nobody vouched.",
          modules: [],
          topics: [],
          symbols: [],
          trust: "medium",
          confirmed: false,
          confirmedBy: null,
          stale: false,
          status: "active",
          scope: "project",
          createdBy: "agent:job:job-7",
          createdAt: "2026-07-16T01:00:00.000Z",
          updatedAt: "2026-07-16T01:00:00.000Z",
          expiresAt: null,
        },
      ],
      edges: [],
      confirmations: [],
      imports: [],
      total: 1,
      truncated: false,
    }));
    const { rerender } = render(
      React.createElement(MemoryPanel, { chatId: "chat-a", standingConsent: false })
    );
    // Strict posture: the unvouched crew-visible note is a debt.
    expect(await screen.findByText("Needs you")).toBeTruthy();

    rerender(
      React.createElement(MemoryPanel, { chatId: "chat-a", standingConsent: true })
    );
    // Consent armed mid-mount: the SAME mounted panel stops demanding review.
    await waitFor(() => expect(screen.queryByText("Needs you")).toBeNull());

    rerender(
      React.createElement(MemoryPanel, { chatId: "chat-a", standingConsent: false })
    );
    // …and disarming it puts the debt straight back. No one-shot snapshot.
    expect(await screen.findByText("Needs you")).toBeTruthy();
  });

  it("EvidencePanel renders the search form and the auto-context note, without any Memory-workspace chrome", () => {
    installBrainBridge();
    render(React.createElement(EvidencePanel, {}));

    expect(
      screen.getByRole("textbox", { name: "Filter this mission's evidence" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Pre-edit context" })
    ).toBeTruthy();
    expect(screen.queryByLabelText("Memory workspace")).toBeNull();
  });

  it("scopes manual evidence requests to the selected chat", async () => {
    const user = userEvent.setup();
    const preEditContext = vi.fn(async () => contextFixture);
    installBrainBridge({ preEditContext });
    render(React.createElement(EvidencePanel, { chatId: "chat-a" }));

    await submitTarget(user, "src/auth/guard.ts");

    expect(preEditContext).toHaveBeenCalledWith({
      module: "src/auth/guard.ts",
      chatId: "chat-a",
    });
  });

  it("keeps adjudication disabled when proposal text loading fails", async () => {
    const user = userEvent.setup();
    const target = "src/failed-proposal-text.ts";
    const context = contextFor(target, "Proposal gate context.");
    const proposalRequest = deferred<MemoryNote>();
    const updateMemoryNote = vi.fn(async () => context.memories[0]!);
    installBrainBridge({
      dataBoundaries: vi.fn(async () => ({ status: "degraded", reason: "not under test" })),
      preEditContext: vi.fn(async () => context),
      getMemoryNote: vi.fn(() => proposalRequest.promise),
      updateMemoryNote,
    });
    render(React.createElement(EvidencePanel, {}));

    await submitTarget(user, target);
    expect(await screen.findByText("Proposal gate context.")).toBeTruthy();

    const confirm = screen.getByRole("button", {
      name: "Confirm",
    }) as HTMLButtonElement;
    const reject = screen.getByRole("button", {
      name: "Reject",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(reject.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "View proposal" }));
    expect(confirm.disabled).toBe(true);
    expect(reject.disabled).toBe(true);

    await act(async () => {
      proposalRequest.reject(new Error("proposal text unavailable"));
      await proposalRequest.promise.catch(() => undefined);
    });

    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "View proposal",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    expect(confirm.disabled).toBe(true);
    expect(reject.disabled).toBe(true);

    fireEvent.click(confirm);
    fireEvent.click(reject);
    expect(updateMemoryNote).not.toHaveBeenCalled();
  });

  it("allows only one proposal adjudication mutation at a time", async () => {
    const user = userEvent.setup();
    const target = "src/single-flight.ts";
    const context = {
      ...contextFor(target, "Single-flight context."),
      pendingProposals: [
        contextFixture.pendingProposals[0]!,
        {
          ...contextFixture.pendingProposals[0]!,
          proposalNoteId: "proposal-2",
        },
      ],
    };
    const mutation = deferred<MemoryNote>();
    const updateMemoryNote = vi.fn(() => mutation.promise);
    installBrainBridge({
      dataBoundaries: vi.fn(async () => ({ status: "degraded", reason: "not under test" })),
      preEditContext: vi.fn(async () => context),
      getMemoryNote: vi.fn(async (proposalNoteId: string) => ({
        ...context.memories[0]!,
        text: `Informed text for ${proposalNoteId}.`,
      })),
      updateMemoryNote,
    });
    render(React.createElement(EvidencePanel, {}));

    await submitTarget(user, target);
    expect(await screen.findByText("Single-flight context.")).toBeTruthy();
    for (const button of screen.getAllByRole("button", {
      name: "View proposal",
    })) {
      await user.click(button);
    }
    await screen.findByText("Informed text for proposal-2.");

    const confirmButtons = screen.getAllByRole("button", {
      name: "Confirm",
    }) as HTMLButtonElement[];
    await user.click(confirmButtons[0]!);
    expect(updateMemoryNote).toHaveBeenCalledTimes(1);
    expect(confirmButtons[1]!.disabled).toBe(true);

    fireEvent.click(confirmButtons[1]!);
    expect(updateMemoryNote).toHaveBeenCalledTimes(1);

    await act(async () => {
      mutation.resolve(context.memories[0]!);
      await mutation.promise;
    });
  });

  it("keeps adjudication single-flight until its refresh settles", async () => {
    const user = userEvent.setup();
    const target = "src/refresh-single-flight.ts";
    const context = {
      ...contextFor(target, "Refresh single-flight context."),
      pendingProposals: [
        contextFixture.pendingProposals[0]!,
        {
          ...contextFixture.pendingProposals[0]!,
          proposalNoteId: "proposal-2",
        },
      ],
    };
    const refresh = deferred<PreEditContext>();
    const preEditContext = vi
      .fn()
      .mockResolvedValueOnce(context)
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValue(context);
    const updateMemoryNote = vi.fn(async () => context.memories[0]!);
    installBrainBridge({
      preEditContext,
      getMemoryNote: vi.fn(async (proposalNoteId: string) => ({
        ...context.memories[0]!,
        text: `Informed text for ${proposalNoteId}.`,
      })),
      updateMemoryNote,
    });
    render(React.createElement(EvidencePanel, {}));

    await submitTarget(user, target);
    expect(
      await screen.findByText("Refresh single-flight context.")
    ).toBeTruthy();
    for (const button of screen.getAllByRole("button", {
      name: "View proposal",
    })) {
      await user.click(button);
    }
    await screen.findByText("Informed text for proposal-2.");

    await user.click(screen.getAllByRole("button", { name: "Confirm" })[0]!);
    await waitFor(() => expect(preEditContext).toHaveBeenCalledTimes(2));

    const remainingConfirm = screen.getByRole("button", {
      name: "Confirm",
    }) as HTMLButtonElement;
    expect(remainingConfirm.disabled).toBe(true);
    fireEvent.click(remainingConfirm);
    expect(updateMemoryNote).toHaveBeenCalledTimes(1);

    await act(async () => {
      refresh.resolve(context);
      await refresh.promise;
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Confirm",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(updateMemoryNote).toHaveBeenCalledTimes(2));
  });

  it("locally resolves a successful adjudication before refresh and isolates refresh errors", async () => {
    const user = userEvent.setup();
    const target = "src/local-resolution.ts";
    const context = contextFor(target, "Local resolution context.");
    const mutation = deferred<MemoryNote>();
    const refresh = deferred<PreEditContext>();
    const preEditContext = vi
      .fn()
      .mockResolvedValueOnce(context)
      .mockImplementationOnce(() => refresh.promise);
    installBrainBridge({
      preEditContext,
      getMemoryNote: vi.fn(async () => ({
        ...context.memories[0]!,
        text: "Viewed proposal text must clear after mutation.",
      })),
      updateMemoryNote: vi.fn(() => mutation.promise),
    });
    render(React.createElement(EvidencePanel, {}));

    await submitTarget(user, target);
    expect(await screen.findByText("Local resolution context.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "View proposal" }));
    expect(
      await screen.findByText(
        "Viewed proposal text must clear after mutation."
      )
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await act(async () => {
      mutation.resolve(context.memories[0]!);
      await mutation.promise;
    });

    await waitFor(() =>
      expect(screen.queryByText(/proposal-1 contests/)).toBeNull()
    );
    expect(
      screen.queryByText("Viewed proposal text must clear after mutation.")
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();

    await act(async () => {
      refresh.reject(new Error("refresh transport failed"));
      await refresh.promise.catch(() => undefined);
    });

    expect(
      await screen.findByText(
        "Proposal resolved, but context refresh failed: refresh transport failed"
      )
    ).toBeTruthy();
    expect(screen.queryByText(/proposal-1 contests/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });
});

describe("desktop EvidencePanel request fencing", () => {
  it("discards delayed auto-context after a manual target intent begins", async () => {
    const user = userEvent.setup();
    const manualTarget = "src/manual-intent.ts";
    const autoTarget = "src/delayed-auto.ts";
    const manualContext = contextFor(
      manualTarget,
      "Manual intent remains authoritative."
    );
    const autoContext = deferred<
      NonNullable<
        Awaited<ReturnType<Window["muon"]["autoContext"]>>
      >
    >();
    const preEditContext = vi.fn(async () => manualContext);
    installBrainBridge({
      autoContext: vi.fn(() => autoContext.promise),
      preEditContext,
    });
    render(
      React.createElement(EvidencePanel, {
        activeTaskId: "task-with-delayed-auto-context",
      })
    );

    await submitTarget(user, manualTarget);
    expect(
      await screen.findByText("Manual intent remains authoritative.")
    ).toBeTruthy();

    await act(async () => {
      autoContext.resolve({
        input: { module: autoTarget },
        modules: [autoTarget],
        symbols: [],
        label: `auto from active task: ${autoTarget}`,
      });
      await autoContext.promise;
      await Promise.resolve();
    });

    expect(preEditContext).toHaveBeenCalledTimes(1);
    expect(preEditContext).toHaveBeenCalledWith({ module: manualTarget });
    expect(
      (
        screen.getByPlaceholderText(
          /Filter evidence/
        ) as HTMLInputElement
      ).value
    ).toBe(manualTarget);
    expect(
      screen.queryByText(`↳ auto from active task: ${autoTarget}`)
    ).toBeNull();
  });

  it("does not refresh an adjudicated target after a newer intent begins", async () => {
    const user = userEvent.setup();
    const firstTarget = "src/adjudicated-a.ts";
    const secondTarget = "src/manual-b.ts";
    const firstContext = contextFor(
      firstTarget,
      "Target A governed memory."
    );
    const secondContext = contextFor(
      secondTarget,
      "Target B governed memory.",
      false
    );
    const secondRequest = deferred<PreEditContext>();
    const adjudication = deferred<MemoryNote>();
    const preEditContext = vi
      .fn()
      .mockResolvedValueOnce(firstContext)
      .mockImplementationOnce(() => secondRequest.promise)
      .mockResolvedValue(firstContext);
    installBrainBridge({
      preEditContext,
      getMemoryNote: vi.fn(async () => ({
        ...firstContext.memories[0]!,
        text: "Proposal text is informed before adjudication.",
      })),
      updateMemoryNote: vi.fn(() => adjudication.promise),
    });
    render(React.createElement(EvidencePanel, {}));

    await submitTarget(user, firstTarget);
    expect(await screen.findByText("Target A governed memory.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "View proposal" }));
    expect(
      await screen.findByText(
        "Proposal text is informed before adjudication."
      )
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await submitTarget(user, secondTarget);
    expect(preEditContext).toHaveBeenCalledTimes(2);
    expect(preEditContext.mock.calls[1]?.[0]).toEqual({
      module: secondTarget,
    });

    await act(async () => {
      adjudication.resolve(firstContext.memories[0]!);
      await adjudication.promise;
      await Promise.resolve();
    });

    expect(preEditContext).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondRequest.resolve(secondContext);
      await secondRequest.promise;
    });
    expect(await screen.findByText("Target B governed memory.")).toBeTruthy();
    expect(screen.queryByText("Target A governed memory.")).toBeNull();
  });

  it("invalidates an in-flight adjudication when activeTaskId changes", async () => {
    const user = userEvent.setup();
    const firstTarget = "src/task-a.ts";
    const secondTarget = "src/task-b.ts";
    const firstContext = contextFor(firstTarget, "Task A context.");
    const secondContext = contextFor(
      secondTarget,
      "Task B context.",
      false
    );
    const secondAutoContext = deferred<
      NonNullable<
        Awaited<ReturnType<Window["muon"]["autoContext"]>>
      >
    >();
    const mutation = deferred<MemoryNote>();
    const autoContext = vi
      .fn()
      .mockResolvedValueOnce({
        input: { module: firstTarget },
        modules: [firstTarget],
        symbols: [],
        label: `auto from active task: ${firstTarget}`,
      })
      .mockImplementationOnce(() => secondAutoContext.promise);
    const preEditContext = vi.fn(
      async (input: PreEditContext["target"]) =>
        input.module === secondTarget ? secondContext : firstContext
    );
    installBrainBridge({
      autoContext,
      preEditContext,
      getMemoryNote: vi.fn(async () => ({
        ...firstContext.memories[0]!,
        text: "Task A proposal text.",
      })),
      updateMemoryNote: vi.fn(() => mutation.promise),
    });
    const { rerender } = render(
      React.createElement(EvidencePanel, {
        activeTaskId: "task-a",
      })
    );

    expect(await screen.findByText("Task A context.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "View proposal" }));
    expect(await screen.findByText("Task A proposal text.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    rerender(
      React.createElement(EvidencePanel, {
        activeTaskId: "task-b",
      })
    );
    await waitFor(() => expect(autoContext).toHaveBeenCalledTimes(2));

    await act(async () => {
      mutation.resolve(firstContext.memories[0]!);
      await mutation.promise;
      await Promise.resolve();
    });
    expect(preEditContext).toHaveBeenCalledTimes(1);

    await act(async () => {
      secondAutoContext.resolve({
        input: { module: secondTarget },
        modules: [secondTarget],
        symbols: [],
        label: `auto from active task: ${secondTarget}`,
      });
      await secondAutoContext.promise;
    });
    expect(await screen.findByText("Task B context.")).toBeTruthy();
    expect(preEditContext).toHaveBeenCalledTimes(2);
  });

  it("clears stale loading when activeTaskId changes without auto-context", async () => {
    const target = "src/loading-task.ts";
    const staleRequest = deferred<PreEditContext>();
    installBrainBridge({
      autoContext: vi.fn(async () => ({
        input: { module: target },
        modules: [target],
        symbols: [],
        label: `auto from active task: ${target}`,
      })),
      dataBoundaries: vi.fn(async () => ({ status: "degraded", reason: "not under test" })),
      preEditContext: vi.fn(() => staleRequest.promise),
    });
    const { rerender } = render(
      React.createElement(EvidencePanel, {
        activeTaskId: "loading-task",
      })
    );

    expect(
      await screen.findByRole("button", { name: "Loading…" })
    ).toBeTruthy();

    rerender(
      React.createElement(EvidencePanel, {
        activeTaskId: null,
      })
    );
    expect(
      await screen.findByRole("button", { name: "Pre-edit context" })
    ).toBeTruthy();

    await act(async () => {
      staleRequest.reject(new Error("stale task context failed"));
      await staleRequest.promise.catch(() => undefined);
    });
    expect(screen.queryByText("stale task context failed")).toBeNull();
  });

  it("keeps the newest context, loading, error, and refresh input authoritative", async () => {
    const user = userEvent.setup();
    const staleSuccess = deferred<PreEditContext>();
    const staleError = deferred<PreEditContext>();
    const newest = deferred<PreEditContext>();
    const staleTarget = "src/old-success.ts";
    const errorTarget = "src/old-error.ts";
    const newestTarget = "src/newest.ts";
    const staleContext = contextFor(
      staleTarget,
      "Stale governed memory must not render."
    );
    const newestContext = contextFor(
      newestTarget,
      "Newest governed memory remains authoritative."
    );
    const preEditContext = vi
      .fn()
      .mockImplementationOnce(() => staleSuccess.promise)
      .mockImplementationOnce(() => staleError.promise)
      .mockImplementationOnce(() => newest.promise)
      .mockResolvedValue(newestContext);
    installBrainBridge({
      preEditContext,
      updateMemoryNote: vi.fn(async () => newestContext.memories[0]!),
    });
    render(React.createElement(EvidencePanel, {}));

    await submitTarget(user, staleTarget);
    await submitTarget(user, errorTarget);
    await submitTarget(user, newestTarget);
    expect(preEditContext).toHaveBeenCalledTimes(3);

    await act(async () => {
      staleError.reject(new Error("stale context failure"));
      await Promise.resolve();
    });
    expect(
      screen.getByRole("button", { name: "Loading…" })
    ).toBeTruthy();
    expect(screen.queryByText("stale context failure")).toBeNull();

    await act(async () => {
      newest.resolve(newestContext);
      await newest.promise;
    });
    expect(
      await screen.findByText("Newest governed memory remains authoritative.")
    ).toBeTruthy();
    expect(screen.queryByText("stale context failure")).toBeNull();

    await act(async () => {
      staleSuccess.resolve(staleContext);
      await staleSuccess.promise;
    });
    expect(
      screen.queryByText("Stale governed memory must not render.")
    ).toBeNull();
    expect(
      (
        screen.getByPlaceholderText(
          /Filter evidence/
        ) as HTMLInputElement
      ).value
    ).toBe(newestTarget);

    await user.click(screen.getByRole("button", { name: "View proposal" }));
    expect(
      await screen.findByText("Authorization stays deny-by-default.")
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(preEditContext).toHaveBeenCalledTimes(4));
    expect(preEditContext.mock.calls[3]?.[0]).toEqual({
      module: newestTarget,
    });
  });

  it("keeps the last successful context authoritative when a newer load fails", async () => {
    const user = userEvent.setup();
    const successfulTarget = "src/successful.ts";
    const failingTarget = "src/failing.ts";
    const successfulContext = contextFor(
      successfulTarget,
      "The successful context remains visible."
    );
    const preEditContext = vi
      .fn()
      .mockResolvedValueOnce(successfulContext)
      .mockRejectedValueOnce(new Error("newest context failed"))
      .mockResolvedValue(successfulContext);
    installBrainBridge({
      preEditContext,
      updateMemoryNote: vi.fn(async () => successfulContext.memories[0]!),
    });
    render(React.createElement(EvidencePanel, {}));

    await submitTarget(user, successfulTarget);
    expect(
      await screen.findByText("The successful context remains visible.")
    ).toBeTruthy();

    await submitTarget(user, failingTarget);
    expect(await screen.findByText("newest context failed")).toBeTruthy();
    expect(
      screen.getByText("The successful context remains visible.")
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "View proposal" }));
    expect(
      await screen.findByText("Authorization stays deny-by-default.")
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(preEditContext).toHaveBeenCalledTimes(3));
    expect(preEditContext.mock.calls[2]?.[0]).toEqual({
      module: successfulTarget,
    });
  });

  it("keeps a successfully adjudicated proposal resolved when refresh fails", async () => {
    const user = userEvent.setup();
    const target = "src/proposal-refresh.ts";
    const completedProposalText = "Completed proposal text stays visible.";
    const context = contextFor(target, "Proposal refresh context.");
    const preEditContext = vi
      .fn()
      .mockResolvedValueOnce(context)
      .mockRejectedValueOnce(new Error("refresh failed"));
    const getMemoryNote = vi.fn(async () => ({
      ...context.memories[0]!,
      text: completedProposalText,
    }));
    installBrainBridge({
      preEditContext,
      getMemoryNote,
      updateMemoryNote: vi.fn(async () => context.memories[0]!),
    });
    render(React.createElement(EvidencePanel, {}));

    await submitTarget(user, target);
    expect(await screen.findByText("Proposal refresh context.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "View proposal" }));
    expect(await screen.findByText(completedProposalText)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(
      await screen.findByText(
        "Proposal resolved, but context refresh failed: refresh failed"
      )
    ).toBeTruthy();
    expect(screen.queryByText(completedProposalText)).toBeNull();
    expect(screen.queryByRole("button", { name: "View proposal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("suppresses proposal text fetched for an invalidated context", async () => {
    const user = userEvent.setup();
    const firstTarget = "src/first.ts";
    const secondTarget = "src/second.ts";
    const staleProposalText = "Stale proposal text must stay cleared.";
    const firstContext = contextFor(
      firstTarget,
      "First governed memory."
    );
    const secondContext = contextFor(
      secondTarget,
      "Second governed memory.",
      false
    );
    const secondRequest = deferred<PreEditContext>();
    const proposalRequest = deferred<MemoryNote>();
    const preEditContext = vi
      .fn()
      .mockResolvedValueOnce(firstContext)
      .mockImplementationOnce(() => secondRequest.promise);
    const getMemoryNote = vi.fn(() => proposalRequest.promise);
    installBrainBridge({ preEditContext, getMemoryNote });
    render(React.createElement(EvidencePanel, {}));

    await submitTarget(user, firstTarget);
    expect(await screen.findByText("First governed memory.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "View proposal" }));
    expect(getMemoryNote).toHaveBeenCalledWith("proposal-1");

    await submitTarget(user, secondTarget);
    expect(
      (
        screen.getByRole("button", {
          name: "View proposal",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);

    await act(async () => {
      proposalRequest.resolve({
        ...firstContext.memories[0]!,
        text: staleProposalText,
      });
      await proposalRequest.promise;
    });
    expect(screen.queryByText(staleProposalText)).toBeNull();

    await act(async () => {
      secondRequest.resolve(secondContext);
      await secondRequest.promise;
    });
    expect(await screen.findByText("Second governed memory.")).toBeTruthy();
    expect(screen.queryByText(staleProposalText)).toBeNull();
  });
});
