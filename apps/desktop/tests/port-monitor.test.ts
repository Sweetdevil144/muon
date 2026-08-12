import { describe, expect, it } from "vitest";
import {
  canPreviewPortForBoundChat,
  portsForBoundChat,
} from "../src/lib/port-monitor.js";

describe("port-monitor association wiring", () => {
  it("filters associated ports to one chat workspace", async () => {
    const { associateListeningPorts } = await import("@muon/core");
    const associated = associateListeningPorts({
      ports: [{ pid: 100, port: 3000, address: "127.0.0.1" }],
      processCwds: { 100: "/work/app" },
      workspaces: [{ chatId: "chat-1", workspacePath: "/work/app" }],
      jobs: [],
    });
    expect(portsForBoundChat("chat-1", "/work/app", associated)).toEqual([
      expect.objectContaining({
        port: 3000,
        owner: expect.objectContaining({ chatId: "chat-1" }),
      }),
    ]);
  });

  it("authorizes preview only for a current localhost port in the bound mission", async () => {
    const { associateListeningPorts } = await import("@muon/core");
    const associated = associateListeningPorts({
      ports: [
        { pid: 100, port: 3000, address: "127.0.0.1" },
        { pid: 101, port: 4000, address: "0.0.0.0" },
        { pid: 102, port: 5000, address: "127.0.0.1" },
      ],
      processCwds: {
        100: "/work/app",
        101: "/work/app",
        102: "/work/other",
      },
      workspaces: [
        { chatId: "chat-1", workspacePath: "/work/app" },
        { chatId: "chat-2", workspacePath: "/work/other" },
      ],
      jobs: [],
    });

    expect(
      canPreviewPortForBoundChat("chat-1", "/work/app", 3000, associated)
    ).toBe(true);
    expect(
      canPreviewPortForBoundChat("chat-1", "/work/app", 4000, associated)
    ).toBe(false);
    expect(
      canPreviewPortForBoundChat("chat-1", "/work/app", 5000, associated)
    ).toBe(false);
    expect(
      canPreviewPortForBoundChat("chat-1", "/work/app", 65_536, associated)
    ).toBe(false);
  });
});
