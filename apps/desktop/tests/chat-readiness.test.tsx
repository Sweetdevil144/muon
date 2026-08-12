// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/renderer/chat.js";

beforeEach(() => {
  Object.assign(window, {
    muon: {
      streams: vi.fn().mockResolvedValue([]),
    },
  });
});

afterEach(cleanup);

describe("Mission provider recovery", () => {
  it("blocks only sending while keeping provider recovery controls usable", () => {
    const onRefresh = vi.fn();
    const onUseFallback = vi.fn();
    render(
      React.createElement(ChatView, {
        chat: {
          id: "chat-1",
          title: "Repair parser",
          workspacePath: "/repo",
        },
        approvals: [],
        running: false,
        live: [],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
        model: null,
        defaultModel: "gpt-5.6-sol",
        onSetModel: vi.fn(),
        orchestratorVendor: "codex",
        onSetOrchestratorVendor: vi.fn(),
        orchestratorEffort: "xhigh",
        onSetOrchestratorEffort: vi.fn(),
        modelCatalog: null,
        orchestratorReadinessIssue: {
          vendor: "codex",
          label: "Codex",
          blocking: true,
          detail: "Missing environment variable: AZURE_OPENAI_API_KEY.",
          fixHint:
            "Add it to ~/.zshenv, restart MUON, then re-check readiness.",
        },
        onRecheckReadiness: onRefresh,
        fallbackOrchestratorVendor: "claude-code",
        onUseFallbackOrchestrator: onUseFallback,
      })
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "AZURE_OPENAI_API_KEY"
    );
    expect(
      (screen.getByLabelText("Message to MUON") as HTMLTextAreaElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(
      "Add it to ~/.zshenv"
    );
    expect(
      (
        screen.getByRole("button", {
          name: /gpt-5\.6-sol/i,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Use Claude Code instead" })
    );
    expect(onUseFallback).toHaveBeenCalledWith("claude-code");
  });
});
