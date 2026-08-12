// @vitest-environment jsdom

import React from "react";
import userEvent from "@testing-library/user-event";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "@muon/client";
import { CrewPanel } from "../src/renderer/sidebar.js";
import type { DesktopState } from "../src/shared/ipc.js";

// ── S8: crew-click → live stream view (sidebar crew rail) ───────────────────
//
// Clicking any RUNNING orchestrated agent in the crew rail must open the
// complete live view of that agent's session — the CSS clickability hook is
// renamed from the working-only `.agent-row.working` to a semantic
// `.agent-row.clickable` (UI round-2 spec §11b) so a later slice can widen
// which statuses qualify by touching only the JS gate, never the CSS. FD-5
// keeps that JS gate at status==='working' for this slice: idle agents stay
// non-interactive (no fake liveness), never a silent partial click.

afterEach(cleanup);

function baseState(agents: AgentRecord[]): DesktopState {
  return {
    chats: [],
    fleet: { counts: { codex: agents.length }, agents },
  } as unknown as DesktopState;
}

// The crew now lives in the CrewPanel (rendered inside the Crew modal), not the
// sidebar body — the click behavior under test is unchanged, only its home.
function renderSidebar(agents: AgentRecord[], onOpenAgent = vi.fn()) {
  render(
    React.createElement(CrewPanel, {
      state: baseState(agents),
      taskTitles: new Map(),
      onStepFleet: vi.fn(),
      onOpenAgent,
    })
  );
  return { onOpenAgent };
}

function workingAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    vendor: "codex",
    ordinal: 1,
    name: "Codex 1",
    status: "working",
    currentTaskId: null,
    currentJobId: null,
    ...overrides,
  } as AgentRecord;
}

describe("crew rail click → live stream view (S8)", () => {
  it("switches the orchestrator to the vendor-configured default model", async () => {
    const onSaveCrewConfig = vi.fn(async () => undefined);
    const state = {
      ...baseState([]),
      settings: {
        crew: {
          orchestratorVendor: "claude-code",
          orchestratorModel: "sonnet",
          orchestratorEffort: "medium",
          laneDefaults: {
            "claude-code": { model: "sonnet", effort: "medium" },
            codex: { model: "gpt-5.6-sol", effort: "medium" },
            cursor: { model: "auto", effort: "medium" },
          },
        },
      },
    } as unknown as DesktopState;

    render(
      React.createElement(CrewPanel, {
        state,
        taskTitles: new Map(),
        onStepFleet: vi.fn(),
        onOpenAgent: vi.fn(),
        onSaveCrewConfig,
      })
    );

    fireEvent.change(screen.getByLabelText("Vendor"), {
      target: { value: "codex" },
    });

    await waitFor(() =>
      expect(onSaveCrewConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          orchestratorVendor: "codex",
          orchestratorModel: "",
        })
      )
    );
  });

  it("marks a working agent row with the semantic 'clickable' class and opens its session on click", () => {
    const { onOpenAgent } = renderSidebar([workingAgent()]);
    const row = screen.getByRole("button", {
      name: /open this agent's stream/i,
    });
    expect(row.className).toContain("clickable");
    fireEvent.click(row);
    expect(onOpenAgent).toHaveBeenCalledWith("agent-1");
  });

  it("opens the agent's session on Enter when the row is keyboard-focused", async () => {
    const user = userEvent.setup();
    const { onOpenAgent } = renderSidebar([workingAgent()]);
    const row = screen.getByRole("button", {
      name: /open this agent's stream/i,
    });
    row.focus();
    await user.keyboard("{Enter}");
    expect(onOpenAgent).toHaveBeenCalledWith("agent-1");
  });

  it("does not mark an idle agent row clickable, and clicking it is a no-op (no fake liveness)", () => {
    const { onOpenAgent } = renderSidebar([
      workingAgent({ id: "agent-2", name: "Codex 2", status: "idle" }),
    ]);
    const row = screen.getByRole("button", { name: /idle/ });
    expect(row.className).not.toContain("clickable");
    fireEvent.click(row);
    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it("keeps the status dot's '.working' class independent of the clickable rename", () => {
    renderSidebar([workingAgent()]);
    const row = screen.getByRole("button", {
      name: /open this agent's stream/i,
    });
    expect(row.className).toContain("working");
    expect(row.querySelector(".dot.working")).toBeTruthy();
  });

  it("surfaces selected-orchestrator readiness and offers a ready fallback", () => {
    const state = {
      ...baseState([]),
      settings: {
        crew: {
          orchestratorVendor: "codex",
          orchestratorModel: "gpt-5.6-sol",
          orchestratorEffort: "xhigh",
          laneDefaults: {
            "claude-code": { model: "sonnet", effort: "medium" },
            codex: { model: "gpt-5.6-sol", effort: "xhigh" },
            cursor: { model: "auto", effort: "medium" },
          },
        },
      },
      readiness: [
        {
          vendor: "codex",
          installed: true,
          authenticated: false,
          authState: "provider-unconfigured",
          detail: "Missing environment variable: AZURE_OPENAI_API_KEY.",
          fixHint: "Restart MUON after configuring the selected provider key.",
        },
        {
          vendor: "claude-code",
          installed: true,
          authenticated: true,
          detail: "Claude Code is ready",
        },
      ],
    } as unknown as DesktopState;

    render(
      React.createElement(CrewPanel, {
        state,
        taskTitles: new Map(),
        onStepFleet: vi.fn(),
        onOpenAgent: vi.fn(),
        onSaveCrewConfig: vi.fn(async () => undefined),
      })
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "AZURE_OPENAI_API_KEY"
    );
    expect(
      screen.getByRole("button", { name: "Use Claude Code instead" })
    ).toBeTruthy();
  });

  it("lets a connected Cursor be SCALED (it is a managed read-only lane, ADR-0020) and names its roles", () => {
    const onStepFleet = vi.fn();
    const state = {
      ...baseState([]),
      fleet: { counts: { cursor: 0 }, agents: [] },
      readiness: [
        {
          vendor: "cursor",
          installed: true,
          authenticated: true,
          detail: "Cursor is connected",
        },
      ],
    } as unknown as DesktopState;

    render(
      React.createElement(CrewPanel, {
        state,
        taskTitles: new Map(),
        onStepFleet,
        onOpenAgent: vi.fn(),
      })
    );

    // The bug: `muon fleet set --cursor` worked from the terminal while this
    // stepper was hardcoded disabled, so the app could not scale a lane the CLI
    // could.
    const add = screen.getByRole("button", {
      name: "Add a Cursor instance",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(onStepFleet).toHaveBeenCalledWith("cursor", 1);

    // …and the copy no longer contradicts the Crew/Topology views.
    expect(screen.queryByText(/takeover/i)).toBeNull();
    expect(screen.queryByText(/does not assign managed jobs/i)).toBeNull();
    expect(screen.getByText("ready · role-scoped")).toBeTruthy();
    // Anchored to CURSOR by name. It used to match on the read-only phrasing
    // alone, which was unique only because the other role-scoped lane at the
    // time (Ollama) held `docs` — a WRITE role — and so rendered different copy.
    // OpenCode is genuinely read-only, so two notes now share that phrasing and
    // an unanchored query is ambiguous.
    const note = screen.getByText(
      /Cursor is a managed dispatch lane for read-only/i
    );
    expect(note.textContent).toContain("reviewer, qa, architect, scout");
    // Never a role Cursor cannot hold — the route 400s on those.
    expect(note.textContent).not.toContain("implementer");
  });

  it("shows OpenCode as a managed, scalable, role-scoped lane", () => {
    const onStepFleet = vi.fn();
    const state = {
      ...baseState([]),
      fleet: { counts: { opencode: 1 }, agents: [] },
      readiness: [
        {
          vendor: "opencode",
          installed: true,
          authenticated: true,
          detail: "logged in (2 stored credentials)",
        },
      ],
    } as unknown as DesktopState;

    render(
      React.createElement(CrewPanel, {
        state,
        taskTitles: new Map(),
        onStepFleet,
        onOpenAgent: vi.fn(),
      })
    );

    // The lane was entirely absent from the app before; the CLI could size it.
    const add = screen.getByRole("button", {
      name: "Add a OpenCode instance",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(onStepFleet).toHaveBeenCalledWith("opencode", 1);
    const note = screen.getByText(/OpenCode is a managed dispatch lane/);
    // One role, and the sidebar must say so rather than borrowing Cursor's
    // wider read-only slice.
    expect(note.textContent).toContain("scout");
    expect(note.textContent).not.toContain("implementer");
    expect(note.textContent).not.toContain("reviewer");
  });

  it("leaves full-role lanes unscoped: no role note, plain ready chip", () => {
    const state = {
      ...baseState([]),
      fleet: { counts: { codex: 0 }, agents: [] },
      readiness: [
        {
          vendor: "codex",
          installed: true,
          authenticated: true,
          detail: "logged in",
        },
      ],
    } as unknown as DesktopState;

    render(
      React.createElement(CrewPanel, {
        state,
        taskTitles: new Map(),
        onStepFleet: vi.fn(),
        onOpenAgent: vi.fn(),
      })
    );

    expect(screen.getByText("ready")).toBeTruthy();
    expect(
      screen.queryByText(/Codex is a managed dispatch lane/)
    ).toBeNull();
  });

  it("surfaces a Crew configuration save failure and restores the saved draft", async () => {
    const onSaveCrewConfig = vi.fn(async () => {
      throw new Error("settings file is read-only");
    });
    const state = {
      ...baseState([]),
      settings: {
        crew: {
          orchestratorVendor: "claude-code",
          orchestratorModel: "sonnet",
          orchestratorEffort: "medium",
          laneDefaults: {
            "claude-code": { model: "sonnet", effort: "medium" },
            codex: { model: "gpt-5.6-sol", effort: "medium" },
            cursor: { model: "auto", effort: "medium" },
          },
        },
      },
    } as unknown as DesktopState;

    render(
      React.createElement(CrewPanel, {
        state,
        taskTitles: new Map(),
        onStepFleet: vi.fn(),
        onOpenAgent: vi.fn(),
        onSaveCrewConfig,
      })
    );

    fireEvent.change(screen.getByLabelText("Vendor"), {
      target: { value: "codex" },
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "settings file is read-only"
    );
    expect(
      (screen.getByLabelText("Vendor") as HTMLSelectElement).value
    ).toBe("claude-code");
  });
});
