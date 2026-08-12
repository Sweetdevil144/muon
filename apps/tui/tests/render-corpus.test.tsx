import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { evasionPayloads, residualDanger } from "@muon/client";
import { TaskLedger } from "../src/components/TaskLedger.js";
import { FormPrompt } from "../src/components/FormPrompt.js";
import { FleetRail } from "../src/components/FleetRail.js";
import { WorkflowPanel } from "../src/components/WorkflowPanel.js";
import { TabStrip } from "../src/components/TabStrip.js";
import { DispatchHero } from "../src/components/CockpitPanels.js";
import { App } from "../src/components/App.js";
import { MuonApiClient } from "@muon/client";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";
import type { BrainSnapshot, BrainStore } from "../src/lib/brain-store.js";

/**
 * THE ENFORCEMENT MECHANISM, replacing a habit.
 *
 * Four reviews in a row found the same defect in a different place: a store
 * field reaching a frame without `terminalSafe`. Each time it was fixed where
 * it was found — a status line, a catalogue entry, a lane key — and each time
 * the next review found the next one. The last fix claimed a "render boundary"
 * that covered exactly ONE `<Text>` per desk while `FormPrompt`, `TaskLedger`
 * and `DispatchHero` kept rendering agent-authored text verbatim.
 *
 * A per-line `terminalSafe` call is a habit, and the next writer forgets it.
 * This is the boundary stated as a TEST: every component that interpolates a
 * store field replays the shared evasion corpus through every text-bearing
 * prop, and the rendered frame must carry no dangerous code point. A new
 * component added without sanitizing fails here rather than in production.
 *
 * PROVENANCE IS NOT HYPOTHETICAL. `create_task` accepts an agent's title
 * (`packages/mcp/src/orchestrator-tools.ts` → `String(args.title ?? "")`) and
 * the backend validates only `z.string().min(3)`, so an MCP-connected agent
 * chooses the string that lands in the ledger's permanent chrome.
 */

/** Ink's own styling and box-drawing are MUON's; only payload bytes matter. */
function plainFrame(frame: string | undefined): string {
  return (frame ?? "").replace(/\[[0-9;]*m/g, "");
}

/** The classes that carry control/format characters. Homoglyphs are a
 *  different control (a confusable fold) and pass through by design. */
const CONTROL_CLASSES = [
  "invisible-directive",
  "reorder",
  "repaint",
  "row-forgery",
] as const;

function assertClean(label: string, frame: string | undefined, payloadId: string) {
  const plain = plainFrame(frame);
  expect(
    residualDanger(plain, ["\n"]),
    `${label} leaked hostile bytes for payload ${payloadId}`
  ).toEqual([]);
}

describe("every rendered component flattens the untrusted text it interpolates", () => {
  it("TaskLedger — task titles are AGENT-AUTHORED via create_task", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const view = render(
        <TaskLedger
          tasks={[
            {
              id: "task-1",
              title: payload.text,
              status: "in_progress",
              priority: "high",
            },
          ] as never}
          focused
          selectedIndex={0}
        />
      );
      assertClean("TaskLedger", view.lastFrame(), payload.id);
      view.unmount();
    }
  }, 30_000);

  it("FormPrompt — the error carries backend and vendor text", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const view = render(
        <FormPrompt
          form={{
            commandId: "task-new",
            title: payload.text,
            fields: [{ id: "a", label: payload.text, required: true }],
          } as never}
          values={{ a: payload.text }}
          fieldIndex={0}
          error={payload.text}
          busy={false}
          hint={payload.text}
        />
      );
      assertClean("FormPrompt", view.lastFrame(), payload.id);
      view.unmount();
    }
  }, 30_000);

  it("DispatchHero — the target comes from agent-authored symbols/modules", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const view = render(
        <DispatchHero
          summary={{
            target: payload.text,
            degraded: false,
            reasons: [payload.text],
          } as never}
          width={80}
        />
      );
      assertClean("DispatchHero", view.lastFrame(), payload.id);
      view.unmount();
    }
  }, 30_000);

  it("FleetRail — agent names are stored text", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const view = render(
        <FleetRail
          agents={[
            {
              id: "agent-1",
              vendor: "codex",
              name: payload.text,
              ordinal: 1,
              status: "working",
            },
          ] as never}
          focused
          selectedIndex={0}
        />
      );
      assertClean("FleetRail", view.lastFrame(), payload.id);
      view.unmount();
    }
  }, 30_000);

  it("WorkflowPanel — a proposal summary is agent-authored", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const view = render(
        <WorkflowPanel
          runs={[
            {
              id: "run-1",
              status: "proposed",
              templateKey: payload.text,
              proposal: { summary: payload.text, steps: [] },
            },
          ] as never}
          selectedIndex={0}
        />
      );
      assertClean("WorkflowPanel", view.lastFrame(), payload.id);
      view.unmount();
    }
  }, 30_000);

  it("TabStrip — a stream tab is titled from an agent name", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const view = render(
        <TabStrip
          state={{
            tabs: [
              { id: "chat", kind: "chat", title: payload.text },
            ],
            activeId: "chat",
          } as never}
          width={80}
        />
      );
      assertClean("TabStrip", view.lastFrame(), payload.id);
      view.unmount();
    }
  }, 30_000);

  it("the CLASSIC desk, whole, renders a poisoned snapshot cleanly", () => {
    // The strongest form of this suite, and the one the review said was
    // missing: the classic desk's own fix had NO test, so reverting it left
    // 448/448 green. Rather than pin one `<Text>`, drive the entire desk with
    // a snapshot whose every human-visible string is a corpus payload. Any
    // component on that surface that forgets to flatten fails here.
    //
    // Both desks ship. `npm run tui` is the ADR-0042 desk (default since
    // 2026-08-08) and `npm run tui:legacy` is this one, which still owns the
    // sixteen commands the new desk has not ported — so a human is still on
    // this surface and it still has to be safe.
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const snapshot: BrainSnapshot = {
        ...emptyBrainSnapshot(),
        agents: [
          {
            id: "agent-1",
            vendor: "codex",
            name: payload.text,
            ordinal: 1,
            status: "working",
          },
        ] as never,
        tasks: [
          {
            id: "task-1",
            title: payload.text,
            status: "in_progress",
            priority: "high",
          },
        ] as never,
        lanes: [{ id: "lane-1", key: payload.text, name: payload.text }] as never,
      };
      const store: BrainStore = {
        client: new MuonApiClient("http://localhost:4000", async () => {
          throw new Error("no network in render tests");
        }),
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
        refresh: async () => undefined,
        start: () => undefined,
        stop: () => undefined,
      } as unknown as BrainStore;

      const view = render(<App store={store} />);
      assertClean("App (classic desk)", view.lastFrame(), payload.id);
      view.unmount();
    }
  }, 60_000);
});
