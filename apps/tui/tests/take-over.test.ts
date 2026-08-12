import { describe, expect, it } from "vitest";
import {
  latestOwnedByHuman,
  latestTakeOver,
  takeOverCommand,
} from "../src/lib/take-over.js";
import { codexGuardHomePath } from "@muon/core";
import type { LaneSession } from "@muon/client";

function session(overrides: Partial<LaneSession>): LaneSession {
  return {
    id: "s1",
    laneId: "lane-1",
    taskId: "task-1",
    status: "ended",
    startedAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("take-over", () => {
  it("maps vendors to their native resume commands", () => {
    expect(
      takeOverCommand(
        session({
          vendorSessionId: "abc",
          lane: { id: "l", key: "claude-code", name: "", provider: "", role: "", status: "" },
        })
      )
    ).toBe("claude --resume abc");
    expect(
      takeOverCommand(
        session({
          vendorSessionId: "xyz",
          lane: { id: "l", key: "codex", name: "", provider: "", role: "", status: "" },
        })
      )
      // A governed codex rollout lives under MUON's isolated guard home, so the
      // command a human is handed must carry that home or it fails with "No
      // saved session found". Asserted against the SAME source the runner uses,
      // never a second copy of the path.
    ).toBe(`CODEX_HOME=${codexGuardHomePath()} codex resume xyz`);
  });

  it("a printed take-over command must be runnable as printed", () => {
    const printed = takeOverCommand(
      session({
        vendorSessionId: "xyz",
        lane: { id: "l", key: "codex", name: "", provider: "", role: "", status: "" },
      })
    );
    expect(printed).toContain("codex resume xyz");
    expect(printed).toContain("CODEX_HOME=");
    expect(printed).not.toMatch(/^codex resume/);
  });

  it("returns null without a vendor session id", () => {
    expect(takeOverCommand(session({}))).toBeNull();
  });

  it("latestTakeOver picks the first resumable session", () => {
    const result = latestTakeOver([
      session({ id: "s1" }),
      session({
        id: "s2",
        vendorSessionId: "resume-me",
        lane: { id: "l", key: "claude-code", name: "", provider: "", role: "", status: "" },
      }),
    ]);
    expect(result?.session.id).toBe("s2");
    expect(result?.command).toContain("resume-me");
  });
});

describe("ADR-0030 — the RETURN side of the round trip", () => {
  it("finds a human-owned session even when it has no native command", () => {
    // Deliberately not reusing `latestTakeOver` for this. A session can be
    // human-owned with no resume argv (the CLI takes those over by explicit
    // id), and if RETURN required a command such a session would be stuck at
    // owner=human with no way back from this surface.
    const owned = latestOwnedByHuman([
      session({ id: "s-muon", owner: "muon", vendorSessionId: "abc" }),
      session({ id: "s-human", owner: "human" }),
    ]);
    expect(owned?.id).toBe("s-human");
    expect(takeOverCommand(owned!)).toBeNull();
  });

  it("returns null when nothing is human-owned, rather than guessing", () => {
    expect(
      latestOwnedByHuman([
        session({ id: "a", owner: "muon" }),
        session({ id: "b" }),
      ])
    ).toBeNull();
  });

  it("prefers the first human-owned session, stably", () => {
    expect(
      latestOwnedByHuman([
        session({ id: "first", owner: "human" }),
        session({ id: "second", owner: "human" }),
      ])?.id
    ).toBe("first");
  });
});
