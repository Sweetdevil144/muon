// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConfigMenu } from "../src/renderer/agent-config-menu.js";

afterEach(cleanup);

describe("Mission agent configuration menu", () => {
  it("TODO 3.9: signed-out providers are blocked with the probe reason", () => {
    render(
      React.createElement(AgentConfigMenu, {
        vendor: "claude-code",
        model: null,
        effort: "medium",
        catalog: null,
        readiness: [
          {
            vendor: "claude-code",
            installed: true,
            authenticated: true,
            authState: "confirmed",
            detail: "Claude Code is signed in.",
          },
          {
            vendor: "codex",
            installed: true,
            authenticated: false,
            authState: "negative",
            detail: "Codex is not signed in.",
            fixHint: "codex login",
          },
        ],
        onChangeVendor: vi.fn(),
        onChangeModel: vi.fn(),
        onChangeEffort: vi.fn(),
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude Code/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Provider/i }));
    expect(
      screen.getByRole("button", { name: /Claude Code · ready/i })
    ).toBeTruthy();
    const blocked = screen.getByRole("button", {
      name: /Codex · signed out/i,
    });
    expect(blocked).toHaveProperty("disabled", true);
    expect(screen.getByText("codex login")).toBeTruthy();
  });

  it("TODO 3.14: always offers Configure agents in the root menu", () => {
    const onConfigureAgents = vi.fn();
    render(
      React.createElement(AgentConfigMenu, {
        vendor: "claude-code",
        model: null,
        effort: "medium",
        catalog: null,
        onChangeVendor: vi.fn(),
        onChangeModel: vi.fn(),
        onChangeEffort: vi.fn(),
        onConfigureAgents,
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude Code/i }));
    fireEvent.click(screen.getByRole("button", { name: /Configure agents/i }));
    expect(onConfigureAgents).toHaveBeenCalledTimes(1);
  });

  it("TODO 3.11: shows cost ordinal on provider rows without fake dollars", () => {
    render(
      React.createElement(AgentConfigMenu, {
        vendor: "claude-code",
        model: null,
        effort: "medium",
        catalog: null,
        readiness: [
          {
            vendor: "claude-code",
            installed: true,
            authenticated: true,
            authState: "confirmed",
            detail: "Claude Code is signed in.",
          },
        ],
        crewLanes: [
          { vendor: "claude-code", costOrdinal: 0.9 },
          { vendor: "codex", costOrdinal: 0.4 },
        ],
        crewCostNotice: "cost accounting not yet metered",
        onChangeVendor: vi.fn(),
        onChangeModel: vi.fn(),
        onChangeEffort: vi.fn(),
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude Code/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Provider/i }));
    expect(screen.getByText(/cost · high \(0\.9\)/i)).toBeTruthy();
  });

  it("shows the effective Crew model when the chat has no override", () => {
    render(
      React.createElement(AgentConfigMenu, {
        vendor: "codex",
        defaultModel: "gpt-5.6-sol",
        model: null,
        effort: "xhigh",
        catalog: {
          vendor: "codex",
          source: "fallback",
          models: [
            {
              id: "gpt-5.6-sol",
              label: "gpt-5.6-sol",
              efforts: ["high", "xhigh"],
            },
          ],
        },
        onChangeVendor: vi.fn(),
        onChangeModel: vi.fn(),
        onChangeEffort: vi.fn(),
      })
    );

    expect(screen.getByText("gpt-5.6-sol")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /gpt-5\.6-sol/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Model/i }));
    expect(
      screen.getByRole("button", {
        name: /Crew default · gpt-5\.6-sol/i,
      })
    ).toBeTruthy();
  });
});
