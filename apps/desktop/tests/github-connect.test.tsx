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

/**
 * Founder bug (2026-08-19): after `muon login`, the GATE SCREEN's panel showed
 * a green "Connected as X" row — whose only control was Disconnect — beside a
 * lock that would not open, because the brain was connected while the desktop
 * held no credential of its own. On the gate screen the panel must always offer
 * the door.
 */
describe("GitHubConnectPanel on the gate screen (gateLocked)", () => {
  it("offers Connect and names the split instead of a green Connected row", () => {
    render(
      <GitHubConnectPanel
        status={{ configured: true, connected: true, login: "operator" }}
        gateLocked
        onStart={vi.fn()}
        onPoll={vi.fn()}
        onDisconnect={vi.fn()}
        onOpenUrl={vi.fn()}
      />
    );
    // The door, not the status row.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(document.body.textContent).not.toContain("Connected as operator");
    // The split is named, with both remedies.
    expect(document.body.textContent).toContain("muon login");
    expect(document.body.textContent).toContain("live brain");
  });

  it("does not show the split note when the brain is not connected either", () => {
    render(
      <GitHubConnectPanel
        status={{ configured: true, connected: false }}
        gateLocked
        onStart={vi.fn()}
        onPoll={vi.fn()}
        onDisconnect={vi.fn()}
        onOpenUrl={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("live brain");
  });
});

/**
 * Founder request (2026-08-19): the device-code card is a claim, not a control
 * cluster — auto-copy happens in start(), the hint says the code is on the
 * clipboard, and a Copy button exists only when the clipboard refused.
 */
describe("device-code card copy affordance", () => {
  const flowStart = {
    flowId: "73f851f5-17ea-4bfd-aab8-cd2100a1f415",
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device",
    expiresAt: "2026-07-21T12:15:00.000Z",
    intervalMs: 60_000,
  };

  it("claims the clipboard and hides the copy button when auto-copy lands", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <GitHubConnectPanel
        status={{ configured: true, connected: false }}
        onStart={vi.fn().mockResolvedValue(flowStart)}
        onPoll={vi.fn()}
        onDisconnect={vi.fn()}
        onOpenUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("ABCD-EFGH");
    await waitFor(() =>
      expect(document.body.textContent).toContain("on your clipboard")
    );
    expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
    // Re-opening the browser stays available, quietly.
    expect(screen.getByRole("button", { name: "Open GitHub" })).toBeTruthy();
  });

  it("keeps a copy button when the clipboard refuses", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <GitHubConnectPanel
        status={{ configured: true, connected: false }}
        onStart={vi.fn().mockResolvedValue(flowStart)}
        onPoll={vi.fn()}
        onDisconnect={vi.fn()}
        onOpenUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("ABCD-EFGH");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy()
    );
    expect(document.body.textContent).not.toContain("on your clipboard");
  });
});
