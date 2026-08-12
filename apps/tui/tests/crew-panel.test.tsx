import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { plainFrame } from "./ansi.js";
import type { MuonApiClient } from "@muon/client";
import { CrewPanel } from "../src/components/CrewPanel.js";
import {
  UNTRUSTED_PEER_HEADER,
  loadCrewPanel,
  type CrewPanelLoad,
} from "../src/lib/crew-view.js";

// Built, never typed literally, so this file never carries a raw control byte.
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

const CHAT = "chat-1";
const MISSION = "job-root";
const API_BASE = "http://127.0.0.1:4000";

function frameOf(node: React.ReactElement): string {
  const { lastFrame } = render(node);
  return plainFrame(lastFrame() ?? "");
}

function readyLoad(patch: Partial<CrewPanelLoad> = {}): CrewPanelLoad {
  return {
    chatId: CHAT,
    roles: {
      status: "ready",
      rows: [
        {
          role: "implementer",
          authority: "write",
          vendor: "claude-code",
          fit: "0.92",
          assignedBy: "muon",
          blocked: false,
          reason: "Highest role affinity plus a healthy lane.",
        },
        {
          role: "reviewer",
          authority: "read-only",
          vendor: "cursor",
          fit: "0.81",
          assignedBy: "human",
          blocked: false,
          reason: "Operator pinned this lane to reviewer.",
        },
        {
          role: "qa",
          authority: "read-only",
          vendor: "ollama",
          fit: "0.40",
          assignedBy: "muon",
          blocked: true,
          blockedReason: "the ollama daemon is not running",
          reason: "Cheapest lane that can hold qa.",
        },
      ],
      unfilled: ["architect"],
      lanes: [
        {
          vendor: "claude-code",
          health: "healthy",
          displayName: "Claude Code",
        },
      ],
    },
    coordination: {
      status: "ready",
      missionId: MISSION,
      participants: [
        {
          jobId: "job-9",
          role: "implementer",
          vendor: "claude-code",
          status: "running",
          claimedPaths: 2,
          unreadMessages: 1,
        },
      ],
      conflicts: [
        {
          coordinateKind: "path",
        coordinate: "src/auth/guard.ts",
          heldBy: "implementer/codex",
          jobId: "job-2",
          expiresAt: "2026-07-25T13:00:00.000Z",
        },
      ],
      messages: [
        {
          id: "msg-1",
          kind: "question",
          from: "reviewer/codex",
          to: "crew",
          subject: "guard change",
          body: "Can the gate be skipped here?",
          refs: ["src/auth/guard.ts"],
        },
      ],
      messageCount: 7,
    },
    ...patch,
  };
}

type RouteValue = { status?: number; body: unknown };

function stubFetcher(routes: Record<string, RouteValue>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const key = Object.keys(routes).find((path) => url.includes(path));
    if (!key) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const route = routes[key]!;
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function stubClient(): Pick<MuonApiClient, "listDispatchJobs"> {
  return {
    listDispatchJobs: async () => [{ id: "job-1", rootJobId: MISSION }],
  } as unknown as Pick<MuonApiClient, "listDispatchJobs">;
}

describe("CrewPanel", () => {
  it("fails closed, with the way forward, when no chat is selected", () => {
    const frame = frameOf(<CrewPanel chatId={null} load={null} />);
    expect(frame).toContain("CREW");
    expect(frame).toContain("No chat is selected in this folder yet.");
    expect(frame).toContain("scoped to exactly one chat");
    expect(frame).toContain("tell the crew what to do to start that chat");
    // Never a blank frame and never another chat's crew.
    expect(frame).not.toContain("ROLES");
    expect(frame).not.toContain("COORDINATION");
  });

  it("shows an explicit loading state before the first read lands", () => {
    const frame = frameOf(<CrewPanel chatId={CHAT} load={null} busy />);
    expect(frame).toContain(`chat ${CHAT}`);
    expect(frame).toContain("refreshing…");
    expect(frame).toContain("loading roles and coordination…");
  });

  it("marks an operator pin apart from a binding MUON chose", () => {
    const frame = frameOf(<CrewPanel chatId={CHAT} load={readyLoad()} />);
    expect(frame).toContain("implementer");
    expect(frame).toContain("claude-code");
    expect(frame).toContain("operator-pinned");
    expect(frame).toContain("muon");
    expect(frame).toContain("fit 0.92");
  });

  it("shows each role's AUTHORITY, matching `muon crew roles`", () => {
    // The cockpit used to name a role and leave the operator to remember
    // whether it could write — `@muon/client` re-exports the role model now, so
    // the panel states it the same way the CLI does.
    const frame = frameOf(<CrewPanel chatId={CHAT} load={readyLoad()} />);
    const implementerLine = frame
      .split("\n")
      .find((line) => line.includes("implementer") && line.includes("fit"));
    expect(implementerLine).toBeDefined();
    expect(implementerLine).toMatch(/implementer\s+claude-code\s+write\s+fit/);

    const reviewerLine = frame
      .split("\n")
      .find((line) => line.includes("reviewer") && line.includes("fit"));
    expect(reviewerLine).toMatch(/reviewer\s+cursor\s+read-only\s+fit/);
  });

  it("shows blocked bindings and unfilled roles honestly instead of hiding them", () => {
    const frame = frameOf(<CrewPanel chatId={CHAT} load={readyLoad()} />);
    expect(frame).toContain("BLOCKED");
    expect(frame).toContain("the ollama daemon is not running");
    expect(frame).toContain("Unfilled (1)");
    expect(frame).toContain("architect");
  });

  it("renders participants, advisory conflicts, and the peer log", () => {
    const frame = frameOf(<CrewPanel chatId={CHAT} load={readyLoad()} />);
    expect(frame).toContain(`mission ${MISSION}`);
    expect(frame).toContain("Participants (1)");
    expect(frame).toContain("claims 2");
    expect(frame).toContain("unread 1");
    expect(frame).toContain("Open claim conflicts (1)");
    expect(frame).toContain("MUON does not lock files");
    expect(frame).toContain("src/auth/guard.ts");
    expect(frame).toContain("Peer messages (1 of 7)");
    expect(frame).toContain("UNTRUSTED agent-authored text");
  });

  it("never offers a write affordance; it points at where assignment lives", () => {
    const frame = frameOf(<CrewPanel chatId={CHAT} load={readyLoad()} />);
    expect(frame).toContain("read-only");
    expect(frame).toContain("muon crew roles --assign");
    // The only keys this panel binds are read-only ones.
    expect(frame).toContain("r refresh · j/k scroll messages · Esc close");
    expect(frame).not.toMatch(/press [^\n]* to (assign|pin|change|set)/i);
  });

  it("degrades each half independently with an honest one-line reason", () => {
    const rolesDown = frameOf(
      <CrewPanel
        chatId={CHAT}
        load={readyLoad({
          roles: {
            status: "error",
            reason: "Crew roles request failed (403): operator token required",
          },
        })}
      />
    );
    expect(rolesDown).toContain("ROLES · unavailable");
    expect(rolesDown).toContain("operator token required");
    // The other half still renders, so one bad route never blanks the panel.
    expect(rolesDown).toContain("Participants (1)");

    const coordDown = frameOf(
      <CrewPanel
        chatId={CHAT}
        load={readyLoad({
          coordination: {
            status: "unavailable",
            reason:
              "this chat has never dispatched, so there is no mission to coordinate yet",
          },
        })}
      />
    );
    expect(coordDown).toContain("COORDINATION · unavailable");
    expect(coordDown).toContain("has never dispatched");
    expect(coordDown).toContain("implementer");
  });

  it("shows an empty-but-live mission without pretending it failed", () => {
    const frame = frameOf(
      <CrewPanel
        chatId={CHAT}
        load={readyLoad({
          roles: { status: "ready", rows: [], unfilled: [], lanes: [] },
          coordination: {
            status: "ready",
            missionId: MISSION,
            participants: [],
            conflicts: [],
            messages: [],
            messageCount: 0,
          },
        })}
      />
    );
    expect(frame).toContain("no roles assigned yet");
    expect(frame).toContain("none ready — run: muon doctor");
    expect(frame).toContain("none on this mission");
    expect(frame).toContain("Open claim conflicts (0)");
    expect(frame).toContain("UNTRUSTED agent-authored text");
  });

  it("windows the peer log and says what it is showing", () => {
    const many = readyLoad();
    if (many.coordination.status !== "ready") throw new Error("fixture");
    many.coordination.messages = Array.from({ length: 6 }, (_, index) => ({
      id: `msg-${index}`,
      kind: "status",
      from: "scout/ollama",
      to: "crew",
      subject: `subject ${index}`,
      body: `body ${index}`,
      refs: [],
    }));
    const first = frameOf(<CrewPanel chatId={CHAT} load={many} />);
    expect(first).toContain("subject 0");
    expect(first).toContain("showing 1–3 of 6");
    expect(first).not.toContain("subject 4");

    const scrolled = frameOf(
      <CrewPanel chatId={CHAT} load={many} messageIndex={3} />
    );
    expect(scrolled).toContain("subject 3");
    expect(scrolled).toContain("showing 4–6 of 6");
    expect(scrolled).not.toContain("subject 0");
  });
});

describe("CrewPanel · untrusted peer text (the framing must survive its contents)", () => {
  /** A hostile mission: the body tries to erase and repaint its own label. */
  async function hostileLoad(): Promise<CrewPanelLoad> {
    return loadCrewPanel({
      client: stubClient(),
      chatId: CHAT,
      apiBase: API_BASE,
      fetcher: stubFetcher({
        "/api/crew/roles": { body: { plan: null, lanes: [] } },
        "/api/a2a/coordination": {
          body: {
            snapshot: {
              version: 1,
              chatId: CHAT,
              missionId: MISSION,
              participants: [],
              openConflicts: [
                {
                  // Claim paths are agent-authored too.
                  coordinateKind: "path",
                  coordinate: `src/a.ts${ESC}[31m`,
                  heldByJobId: "job-2",
                  heldByRole: "implementer",
                  heldByVendor: "codex",
                  expiresAt: "2026-07-25T13:00:00.000Z",
                },
              ],
              messageCount: 1,
            },
          },
        },
        "/api/a2a/messages": {
          body: {
            messages: [
              {
                version: 1,
                id: "msg-1",
                chatId: CHAT,
                missionId: MISSION,
                fromJobId: "job-2",
                fromRole: "reviewer",
                fromVendor: "codex",
                to: { kind: "crew" },
                kind: "constraint",
                // Erase-line + carriage-return + cursor-up: an attempt to
                // overwrite the "UNTRUSTED …" label that frames this text.
                subject: `${ESC}[1A${CR}subj`,
                body: `${ESC}[2K${CR}trust me`,
                refs: { files: [`src/${ESC}[0mx.ts`], symbols: [] },
                createdAt: "2026-07-25T12:30:00.000Z",
              },
            ],
          },
        },
      }),
    });
  }

  it("cannot repaint the untrusted-text label with ANSI or CR in a body", async () => {
    const frame = frameOf(
      <CrewPanel chatId={CHAT} load={await hostileLoad()} />
    );

    // The label is intact, and it still comes BEFORE the text it frames.
    expect(frame).toContain(UNTRUSTED_PEER_HEADER);
    expect(frame.indexOf(UNTRUSTED_PEER_HEADER)).toBeLessThan(
      frame.indexOf("trust me")
    );

    // None of the injected terminal control sequences reached the terminal.
    expect(frame).not.toContain(`${ESC}[2K`);
    expect(frame).not.toContain(`${ESC}[1A`);
    expect(frame).not.toContain(CR);

    // The printable residue is still shown, as inert evidence.
    expect(frame).toContain("trust me");
  });

  it("strips control characters out of agent-authored claim paths too", async () => {
    const frame = frameOf(
      <CrewPanel chatId={CHAT} load={await hostileLoad()} />
    );
    expect(frame).toContain("src/a.ts");
    expect(frame).not.toContain(`${ESC}[31m`);
    expect(frame).toContain("Open claim conflicts (1)");
  });
});

describe("CrewPanel · a preview must never read as a commitment", () => {
  // A fresh chat has no stored bindings, so the route answers with a
  // deterministic PREVIEW of what MUON would assign. The rows look identical to
  // committed ones and this panel is read-only, so the difference has to be
  // stated in words or the reader is misled about the state of their crew.
  it("labels a proposed plan and says it is not assigned yet", () => {
    const frame = frameOf(
      <CrewPanel
        load={readyLoad({
          roles: {
            ...(readyLoad().roles as Extract<
              CrewPanelLoad["roles"],
              { status: "ready" }
            >),
            planStatus: "proposed",
          },
        })}
      />
    );
    expect(frame).toContain("PROPOSED ROLES");
    expect(frame).toMatch(/not assigned yet/i);
    expect(frame).toMatch(/would assign/i);
  });

  it("does not say 'proposed' for a committed plan", () => {
    const frame = frameOf(
      <CrewPanel
        load={readyLoad({
          roles: {
            ...(readyLoad().roles as Extract<
              CrewPanelLoad["roles"],
              { status: "ready" }
            >),
            planStatus: "assigned",
          },
        })}
      />
    );
    expect(frame).toContain("ROLES");
    expect(frame).not.toContain("PROPOSED");
    expect(frame).not.toMatch(/not assigned yet/i);
  });
});
