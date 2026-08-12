// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConfigMenu } from "../src/renderer/agent-config-menu.js";
import { CrewPanel } from "../src/renderer/sidebar.js";
import type { DesktopState, VendorModelResolutionIpc } from "../src/shared/ipc.js";

afterEach(cleanup);

/**
 * D1/D2 — one fact, two surfaces, ONE answer.
 *
 * The Crew page's Orchestrator Model select printed a hardcoded "Vendor
 * default" while the Mission composer printed a model it had actually
 * resolved. Same question, two surfaces, two answers — the drift class this
 * codebase keeps getting bitten by. Both now read the same per-vendor
 * resolution through the same `modelDisplay`/`vendorChoiceLabel` pair, so a
 * change to one cannot leave the other behind.
 */

const RESOLVED: VendorModelResolutionIpc = {
  vendor: "claude-code",
  model: "opus[1m]",
  state: "reported",
  probe: "~/.claude/settings.json",
};

const UNRESOLVED: VendorModelResolutionIpc = {
  vendor: "codex",
  model: null,
  state: "no-probe",
  reason: "this fixture intentionally has no model report.",
};

function crewState(
  vendor: string,
  over: Partial<DesktopState> = {}
): DesktopState {
  return {
    chats: [],
    fleet: { counts: {}, agents: [] },
    settings: {
      crew: {
        orchestratorVendor: vendor,
        orchestratorModel: "",
        orchestratorEffort: "medium",
        laneDefaults: {},
      },
    },
    ...over,
  } as unknown as DesktopState;
}

function renderCrew(vendor: string, props: Record<string, unknown> = {}) {
  return render(
    React.createElement(CrewPanel, {
      state: crewState(vendor),
      taskTitles: new Map(),
      onStepFleet: vi.fn(),
      onOpenAgent: vi.fn(),
      onRequestModelResolution: vi.fn(),
      ...props,
    } as never)
  );
}

/**
 * The composer's closed trigger. Selected by class, not by accessible name:
 * its name is the very copy under test, so naming it would make the selector
 * pass or fail for the same reason the assertion does.
 */
function composerTrigger(): HTMLButtonElement {
  return document.querySelector(".agent-config-trigger") as HTMLButtonElement;
}

/** Open the composer menu down to its Model panel and return that panel's rows. */
function openComposerModelPanel(
  vendor: string,
  resolution: VendorModelResolutionIpc | null
) {
  render(
    React.createElement(AgentConfigMenu, {
      vendor,
      model: null,
      effort: "medium",
      catalog: { vendor, source: "fallback", models: [] },
      modelResolution: resolution,
      onChangeVendor: vi.fn(),
      onChangeModel: vi.fn(),
      onChangeEffort: vi.fn(),
    } as never)
  );
  fireEvent.click(composerTrigger());
  fireEvent.click(screen.getByRole("button", { name: /^Model/i }));
}

/** The Crew page's Orchestrator Model select. */
function crewModelSelect(): HTMLSelectElement {
  return screen.getByRole("combobox", {
    name: "Orchestrator model",
  }) as HTMLSelectElement;
}

describe("Crew page and Mission composer agree on the resolved model", () => {
  it("both read the SAME resolved value from the one resolver", () => {
    renderCrew("claude-code", {
      modelResolutions: { "claude-code": RESOLVED },
    });
    const crewOption = within(crewModelSelect()).getByRole("option", {
      name: /Let Claude Code choose/i,
    });
    expect(crewOption.textContent).toBe("Let Claude Code choose · opus[1m]");
    cleanup();

    openComposerModelPanel("claude-code", RESOLVED);
    const composerRow = screen.getByRole("button", {
      name: /Let Claude Code choose/i,
    });
    expect(composerRow.textContent).toContain(
      "Let Claude Code choose · opus[1m]"
    );
  });

  it("both fall back to the SAME affirmative copy when nothing resolves", () => {
    renderCrew("codex", { modelResolutions: { codex: UNRESOLVED } });
    const crewOption = within(crewModelSelect()).getByRole("option", {
      name: /Let Codex choose/i,
    });
    expect(crewOption.textContent).toBe("Let Codex choose");
    expect(crewOption.textContent).not.toMatch(/not reported/i);
    cleanup();

    openComposerModelPanel("codex", UNRESOLVED);
    const composerRow = screen.getByRole("button", {
      name: /Let Codex choose/i,
    });
    // The row also carries the "selected" checkmark; what matters is that the
    // label itself is the bare action, with no negative appended to it.
    expect(
      composerRow.querySelector("span")?.textContent
    ).toBe("Let Codex choose");
    expect(composerRow.textContent).not.toMatch(/not reported/i);
  });

  it("never prints 'Vendor default' on the Crew page again", () => {
    renderCrew("claude-code", {
      modelResolutions: { "claude-code": RESOLVED },
    });
    expect(screen.queryByText("Vendor default")).toBeNull();
  });

  it("keeps the option VALUE empty — this is a label change, not a grant", () => {
    // Load-bearing: "" still means "MUON names no model". If the resolved model
    // leaked into the value, a DISPLAY resolution would start deciding what
    // gets dispatched, and `validateModelForVendor` would no longer be the only
    // thing that picks a model.
    renderCrew("claude-code", {
      modelResolutions: { "claude-code": RESOLVED },
    });
    const option = within(crewModelSelect()).getByRole("option", {
      name: /Let Claude Code choose/i,
    }) as HTMLOptionElement;
    expect(option.value).toBe("");
    expect(crewModelSelect().value).toBe("");
  });

  it("asks for its OWN vendor's resolution when the Crew page mounts", () => {
    const onRequestModelResolution = vi.fn();
    renderCrew("claude-code", { onRequestModelResolution });
    expect(onRequestModelResolution).toHaveBeenCalledWith("claude-code");
  });

  it("shows the action alone, not a stale model, before the answer arrives", () => {
    renderCrew("claude-code", {
      modelResolutions: {},
      modelResolvingByVendor: { "claude-code": true },
    });
    const option = within(crewModelSelect()).getByRole("option", {
      name: /Let Claude Code choose/i,
    });
    expect(option.textContent).toBe("Let Claude Code choose");
  });

  it("refuses to print another vendor's model under this vendor's name", () => {
    // The map is shared between surfaces; a Codex answer must not be able to
    // surface on a Claude Code row just because it was the last one fetched.
    renderCrew("claude-code", {
      modelResolutions: {
        "claude-code": { ...RESOLVED, vendor: "codex", model: "gpt-5.6-sol" },
      },
    });
    const option = within(crewModelSelect()).getByRole("option", {
      name: /Let Claude Code choose/i,
    });
    expect(option.textContent).toBe("Let Claude Code choose");
    expect(option.textContent).not.toContain("gpt-5.6-sol");
  });
});

describe("Mission composer trigger", () => {
  function renderTrigger(
    resolution: VendorModelResolutionIpc | null,
    props: Record<string, unknown> = {}
  ) {
    render(
      React.createElement(AgentConfigMenu, {
        vendor: "claude-code",
        model: null,
        effort: "medium",
        catalog: { vendor: "claude-code", source: "fallback", models: [] },
        modelResolution: resolution,
        onChangeVendor: vi.fn(),
        onChangeModel: vi.fn(),
        onChangeEffort: vi.fn(),
        ...props,
      } as never)
    );
    return composerTrigger();
  }

  it("shows the resolved model, not 'Not reported'", () => {
    const trigger = renderTrigger(RESOLVED);
    expect(trigger.textContent).toContain("opus[1m]");
    expect(trigger.textContent).not.toMatch(/not reported/i);
  });

  it("names who picks when nothing resolved — never a placeholder", () => {
    const trigger = renderTrigger({
      vendor: "claude-code",
      model: null,
      state: "not-reported",
      reason: "No Claude Code settings file names a model.",
    });
    expect(trigger.textContent).toContain("Claude Code picks");
    expect(trigger.textContent).not.toMatch(/vendor default/i);
    expect(trigger.textContent).not.toMatch(/not reported/i);
  });

  it("resolves on hover, so the closed trigger is right before it is clicked", () => {
    const onRequestModelResolution = vi.fn();
    const onOpen = vi.fn();
    const trigger = renderTrigger(null, { onRequestModelResolution, onOpen });

    fireEvent.pointerEnter(trigger);
    expect(onRequestModelResolution).toHaveBeenCalledTimes(1);
    // Hover must NOT trigger the catalogue fetch, which spawns a vendor CLI on
    // every call; only the cached, single-flighted resolution is asked for.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("also resolves on keyboard focus, so the mouse is not required", () => {
    const onRequestModelResolution = vi.fn();
    const trigger = renderTrigger(null, { onRequestModelResolution });
    fireEvent.focus(trigger);
    expect(onRequestModelResolution).toHaveBeenCalledTimes(1);
  });
});

describe("the model row describes the vendor's choice, not the operator's", () => {
  it("does not advertise an explicitly picked model as the vendor's pick", () => {
    // Regression: the row reused the display built WITH `explicitModel`, so
    // selecting gpt-5.6-sol made the "let the vendor choose" row read
    // "Let Codex choose · gpt-5.6-sol" — the operator's own pick, mislabelled.
    render(
      React.createElement(AgentConfigMenu, {
        vendor: "codex",
        model: "gpt-5.6-sol",
        effort: "medium",
        catalog: {
          vendor: "codex",
          source: "fallback",
          models: [
            { id: "gpt-5.6-sol", label: "gpt-5.6-sol", efforts: ["medium"] },
          ],
        },
        modelResolution: {
          vendor: "codex",
          model: "gpt-5.6-luna",
          state: "reported",
          probe: "codex doctor --json",
        },
        onChangeVendor: vi.fn(),
        onChangeModel: vi.fn(),
        onChangeEffort: vi.fn(),
      } as never)
    );
    fireEvent.click(composerTrigger());
    fireEvent.click(screen.getByRole("button", { name: /^Model/i }));

    const row = screen.getByRole("button", { name: /Let Codex choose/i });
    expect(row.textContent).toContain("Let Codex choose · gpt-5.6-luna");
    expect(row.textContent).not.toContain("gpt-5.6-sol");
  });
});
