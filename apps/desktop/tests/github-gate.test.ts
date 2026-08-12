import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_GATE_EXEMPT_CHANNELS,
  githubGateMisconfigured,
  githubGateRefusal,
  githubGateRequired,
  installGitHubIpcGate,
  type GateableIpc,
} from "../src/lib/github-gate.js";

describe("githubGateRequired (P0-2 policy)", () => {
  const CLIENT_ID = { MUON_GITHUB_CLIENT_ID: "Iv1.abcdef1234567890" };

  it("is OFF in development by default", () => {
    expect(githubGateRequired({ env: {}, isPackaged: false })).toBe(false);
  });
  it("is ON in packaged builds WITH a client id — the launch requirement", () => {
    expect(
      githubGateRequired({ env: { ...CLIENT_ID }, isPackaged: true })
    ).toBe(true);
  });
  it("a packaged build with NO client id does NOT arm — a gate whose door does not exist must not lock", () => {
    // The connect button would be disabled with an env-var instruction as the
    // only copy: a consumer dead end. It degrades to ungated and the caller
    // logs it as a release defect (githubGateMisconfigured).
    expect(githubGateRequired({ env: {}, isPackaged: true })).toBe(false);
    expect(githubGateMisconfigured({ env: {}, isPackaged: true })).toBe(true);
    expect(
      githubGateMisconfigured({ env: { ...CLIENT_ID }, isPackaged: true })
    ).toBe(false);
  });
  it("MUON_REQUIRE_GITHUB_LOGIN arms it anywhere, in every accepted spelling", () => {
    for (const spelling of ["1", "true", "on", " TRUE "]) {
      expect(
        githubGateRequired({
          env: { MUON_REQUIRE_GITHUB_LOGIN: spelling },
          isPackaged: false,
        }),
        spelling
      ).toBe(true);
    }
  });
  it("MUON_REQUIRE_GITHUB_LOGIN=0/false/off is the explicit packaged escape hatch", () => {
    for (const spelling of ["0", "false", "off"]) {
      expect(
        githubGateRequired({
          env: { MUON_REQUIRE_GITHUB_LOGIN: spelling, ...CLIENT_ID },
          isPackaged: true,
        }),
        spelling
      ).toBe(false);
    }
  });
});

describe("installGitHubIpcGate (enforcement at the IPC boundary)", () => {
  function harness() {
    const handlers = new Map<
      string,
      (event: unknown, ...args: unknown[]) => unknown
    >();
    const onHandlers = new Map<
      string,
      (event: unknown, ...args: unknown[]) => void
    >();
    const ipc: GateableIpc = {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      on: (channel, listener) => {
        onHandlers.set(channel, listener);
      },
    };
    return { ipc, handlers, onHandlers };
  }

  it("a NON-exempt channel refuses while the gate is active, and works after", () => {
    const { ipc, handlers } = harness();
    let locked = true;
    installGitHubIpcGate(ipc, () => locked);
    const inner = vi.fn().mockReturnValue("started");
    ipc.handle("muon:createChat", inner);

    expect(() => handlers.get("muon:createChat")!({}, { title: "x" })).toThrow(
      /locked until a GitHub identity is verified/
    );
    expect(inner).not.toHaveBeenCalled();

    // Completing the device flow unlocks WITHOUT re-registration.
    locked = false;
    expect(handlers.get("muon:createChat")!({}, { title: "x" })).toBe("started");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("an exempt channel (the gate's own door, observation, safety) always serves", () => {
    const { ipc, handlers } = harness();
    installGitHubIpcGate(ipc, () => true);
    for (const channel of [
      "muon:startGitHubDeviceFlow",
      "muon:getState",
      "muon:stopAll",
      "muon:resolveApproval",
      "muon:checkForUpdates",
    ]) {
      const inner = vi.fn().mockReturnValue("ok");
      ipc.handle(channel, inner);
      expect(handlers.get(channel)!({}), channel).toBe("ok");
    }
  });

  it("fire-and-forget sends (ipcMain.on) are gated too — the terminal relay cannot bypass", () => {
    const { ipc, onHandlers } = harness();
    let locked = true;
    installGitHubIpcGate(ipc, () => locked);
    const inner = vi.fn();
    ipc.on("muon:openTerminal", inner);

    // Gated: the send is DROPPED (no reply path to refuse on).
    onHandlers.get("muon:openTerminal")!({}, "terminal-chat:chat-1", {});
    expect(inner).not.toHaveBeenCalled();

    locked = false;
    onHandlers.get("muon:openTerminal")!({}, "terminal-chat:chat-1", {});
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("a channel REGISTERED LATER is gated by default — new surfaces fail closed", () => {
    const { ipc, handlers } = harness();
    installGitHubIpcGate(ipc, () => true);
    ipc.handle("muon:someFutureWorkVerb", vi.fn());
    expect(() => handlers.get("muon:someFutureWorkVerb")!({})).toThrow(
      /locked until a GitHub identity/
    );
  });

  it("the exempt list never contains a work-starting or budget-widening verb", () => {
    // setFullAuto/setFullAutoVendors/mcpDetach/dismissWorkflowProposal are
    // deliberately EXEMPT: they are the narrowing/recovery verbs an operator
    // must keep while locked, and the autonomy engines are gate-checked in
    // main so the widen direction of the consent channels is inert until the
    // gate opens.
    for (const forbidden of [
      "muon:createChat",
      "muon:sendMessage",
      "muon:runFirstTask",
      "muon:applyWorkflowProposal",
      "muon:continueOrchestration",
      "muon:resumeObjectiveLoop",
      "muon:shipTask",
      "muon:mcpAttach",
      "muon:mcpInstall",
      "muon:setFleet",
      "muon:raiseDispatchBudget",
      "muon:updateMemoryNote",
      "muon:deleteMemoryNote",
      "muon:createGitHubPullRequest",
      "muon:mergeGitHubPullRequest",
      "muon:openTerminal",
    ]) {
      expect(GITHUB_GATE_EXEMPT_CHANNELS.has(forbidden), forbidden).toBe(false);
    }
  });

  it("the refusal names the channel and the way out", () => {
    const message = githubGateRefusal("muon:createChat");
    expect(message).toContain("muon:createChat");
    expect(message).toMatch(/Sign in with GitHub/);
    expect(message).toMatch(/stops, approvals/);
  });
});
