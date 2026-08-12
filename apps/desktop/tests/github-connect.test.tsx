// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubConnectPanel } from "../src/renderer/sidebar.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("GitHub Setup connection", () => {
  it("starts the device flow, opens the fixed verification page, and shows only the user code", async () => {
    const onOpenUrl = vi.fn().mockResolvedValue(undefined);
    const onStart = vi.fn().mockResolvedValue({
      flowId: "73f851f5-17ea-4bfd-aab8-cd2100a1f415",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresAt: "2026-07-21T12:15:00.000Z",
      intervalMs: 60_000,
    });
    render(
      <GitHubConnectPanel
        status={{ configured: true, connected: false }}
        onStart={onStart}
        onPoll={vi.fn()}
        onDisconnect={vi.fn()}
        onOpenUrl={onOpenUrl}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(onStart).toHaveBeenCalledOnce();
    expect(onOpenUrl).toHaveBeenCalledWith(
      "https://github.com/login/device"
    );
    expect(document.body.textContent).not.toContain("device_code");
    expect(document.body.textContent).not.toContain("access_token");
  });

  it("polls to a safe connected status and supports disconnect", async () => {
    const onPoll = vi.fn().mockResolvedValue({
      status: "connected",
      login: "operator",
      expiresAt: "2026-07-21T20:00:00.000Z",
    });
    const onDisconnect = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <GitHubConnectPanel
        status={{ configured: true, connected: false }}
        onStart={vi.fn().mockResolvedValue({
          flowId: "73f851f5-17ea-4bfd-aab8-cd2100a1f415",
          userCode: "ABCD-EFGH",
          verificationUri: "https://github.com/login/device",
          expiresAt: "2026-07-21T12:15:00.000Z",
          intervalMs: 1,
        })}
        onPoll={onPoll}
        onDisconnect={onDisconnect}
        onOpenUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("ABCD-EFGH");
    await waitFor(() => expect(onPoll).toHaveBeenCalledOnce());

    rerender(
      <GitHubConnectPanel
        status={{ configured: true, connected: true, login: "operator" }}
        onStart={vi.fn()}
        onPoll={onPoll}
        onDisconnect={onDisconnect}
        onOpenUrl={vi.fn()}
      />
    );
    expect(screen.getByText("operator")).toBeTruthy();
    expect(screen.getByText("Connected as operator")).toBeTruthy();
    expect(document.querySelector(".github-account-row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce());
  });

  it("fails closed when the GitHub App client id is not configured", () => {
    render(
      <GitHubConnectPanel
        status={{ configured: false, connected: false }}
        onStart={vi.fn()}
        onPoll={vi.fn()}
        onDisconnect={vi.fn()}
        onOpenUrl={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")
    ).toBe(true);
    expect(screen.getByText(/MUON_GITHUB_CLIENT_ID/)).toBeTruthy();
  });
});
