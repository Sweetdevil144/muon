import { describe, expect, it } from "vitest";
import type { DispatchJobRecord } from "@muon/client";
import {
  deriveMissionTurnState,
  pinLiveTurnRoots,
} from "../src/lib/mission-turn-state.js";

function job(
  id: string,
  status: DispatchJobRecord["status"],
  createdAt: string,
  parentJobId: string | null = null
): DispatchJobRecord {
  return {
    id,
    kind: "session",
    vendor: "codex",
    taskId: `task-${id}`,
    brief: "",
    status,
    agentId: null,
    host: null,
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    result: null,
    exitCode: null,
    createdAt,
    startedAt: null,
    endedAt: null,
    parentJobId,
  };
}

describe("deriveMissionTurnState", () => {
  it("restores a running root after renderer-local state is lost", () => {
    const state = deriveMissionTurnState(
      [
        job("old", "failed", "2026-07-24T00:00:00.000Z"),
        job("active", "running", "2026-07-24T00:01:00.000Z"),
      ],
      false
    );

    expect(state).toMatchObject({
      running: true,
      recovered: true,
      activeRoot: { id: "active" },
      latestRoot: { id: "active" },
    });
  });

  it("does not let an active child claim Mission Chat ownership", () => {
    const state = deriveMissionTurnState(
      [
        job("root", "done", "2026-07-24T00:00:00.000Z"),
        job(
          "child",
          "running",
          "2026-07-24T00:01:00.000Z",
          "root"
        ),
      ],
      false
    );

    expect(state.activeRoot).toBeNull();
    expect(state.running).toBe(false);
    expect(state.latestRoot?.id).toBe("root");
  });

  it("keeps local admission locked before the durable row arrives", () => {
    expect(deriveMissionTurnState([], true)).toMatchObject({
      running: true,
      recovered: false,
      activeRoot: null,
    });
  });
});

function chatJob(
  id: string,
  status: DispatchJobRecord["status"],
  createdAt: string,
  chatId: string
): DispatchJobRecord {
  return { ...job(id, status, createdAt), chatId };
}

describe("pinLiveTurnRoots — the root an open live mirror belongs to", () => {
  it("pins the active root of a chat whose mirror is open", () => {
    const pins = pinLiveTurnRoots({}, ["chat-a"], [
      chatJob("root-1", "running", "2026-07-27T00:00:00.000Z", "chat-a"),
    ]);
    expect(pins["chat-a"]).toBe("root-1");
  });

  it("KEEPS the originating root when a correction root takes over the turn", () => {
    // The crew-contract correction: root-1 went terminal and root-2 was admitted
    // inside the SAME human turn. The live mirror still holds root-1's exchange,
    // so root-1 must remain the transcript boundary.
    const pins = pinLiveTurnRoots({ "chat-a": "root-1" }, ["chat-a"], [
      chatJob("root-1", "failed", "2026-07-27T00:00:00.000Z", "chat-a"),
      chatJob("root-2", "running", "2026-07-27T00:00:09.000Z", "chat-a"),
    ]);
    expect(pins["chat-a"]).toBe("root-1");
  });

  it("releases the pin when the mirror closes", () => {
    const pins = pinLiveTurnRoots({ "chat-a": "root-1" }, [], [
      chatJob("root-2", "running", "2026-07-27T00:00:09.000Z", "chat-a"),
    ]);
    expect(pins["chat-a"]).toBeUndefined();
    expect(Object.keys(pins)).toHaveLength(0);
  });

  it("fails closed while the turn's root has not been admitted yet", () => {
    // Between send() and the durable row landing there is no boundary to cut
    // at. Null, never "whatever ran last" — the caller absorbs nothing.
    const pins = pinLiveTurnRoots({}, ["chat-a"], [
      chatJob("root-0", "done", "2026-07-27T00:00:00.000Z", "chat-a"),
    ]);
    expect(pins["chat-a"]).toBeNull();
  });

  it("pins each chat from its OWN roots, never a sibling chat's", () => {
    const pins = pinLiveTurnRoots({}, ["chat-a", "chat-b"], [
      chatJob("root-a", "running", "2026-07-27T00:00:00.000Z", "chat-a"),
      chatJob("root-b", "running", "2026-07-27T00:00:01.000Z", "chat-b"),
    ]);
    expect(pins).toEqual({ "chat-a": "root-a", "chat-b": "root-b" });
  });
});
