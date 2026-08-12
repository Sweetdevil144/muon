import { describe, expect, it, vi } from "vitest";
import { rolePinSchema } from "@muon/client";
import {
  loadCoordination,
  loadCrewRoles,
  type CrewTopologyFetcher,
} from "../src/lib/crew-topology.js";
import { AGENT_ROLES_IPC } from "../src/shared/ipc.js";

// DRIFT GUARD. `@muon/protocol` is deliberately not a desktop dependency, so
// shared/ipc.ts MIRRORS its role vocabulary by hand. `rolePinSchema.role` is
// the protocol's own `agentRoleSchema`, re-exported through @muon/client — so
// this is a real check against the source of truth, not a restatement of the
// copy. If a role is added upstream and not mirrored here, the topology would
// silently DROP every binding using it; this fails first instead.
describe("AgentRole mirror", () => {
  it("matches the protocol's role vocabulary exactly", () => {
    const canonical = rolePinSchema.shape.role.options as readonly string[];
    expect([...AGENT_ROLES_IPC].sort()).toEqual([...canonical].sort());
  });
});

// The two topology reads hit routes that are NEWER than this surface. The whole
// point of this module is that it can never take the panel down: no throw, no
// rejection, and no trust in the payload's shape.

function fetcherReturning(
  status: number,
  body: unknown,
  onUrl?: (url: string) => void
): CrewTopologyFetcher {
  return async (url) => {
    onUrl?.(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
}

const coords = { apiBase: "http://127.0.0.1:4000", chatId: "chat-1" };

describe("loadCrewRoles — fail soft", () => {
  it("reads the plan and lanes on a healthy 200", async () => {
    let seen = "";
    const result = await loadCrewRoles({
      ...coords,
      apiToken: "operator-token",
      fetcher: fetcherReturning(
        200,
        {
          plan: {
            version: 1,
            chatId: "chat-1",
            bindings: [
              {
                vendor: "claude-code",
                role: "implementer",
                fit: 0.9,
                reason: "worktrees + streaming",
                assignedBy: "muon",
                blocked: false,
              },
            ],
            unfilled: ["qa"],
          },
          lanes: [
            {
              vendor: "codex",
              displayName: "Codex CLI",
              health: "healthy",
              cost: 3,
            },
          ],
        },
        (url) => {
          seen = url;
        }
      ),
    });
    expect(seen).toBe("http://127.0.0.1:4000/api/crew/roles?chatId=chat-1");
    expect(result).toMatchObject({ status: "ok" });
    if (result.status !== "ok") return;
    expect(result.plan?.bindings).toHaveLength(1);
    expect(result.plan?.unfilled).toEqual(["qa"]);
    expect(result.lanes[0]).toMatchObject({
      vendor: "codex",
      displayName: "Codex CLI",
      health: "healthy",
      cost: 3,
    });
  });

  // A plan the brain COMPUTED for an unbound chat is not a plan anyone
  // committed to. Getting this wrong in the safe direction (calling an
  // assignment "proposed") costs a hedge; getting it wrong in the other
  // direction tells the operator MUON decided something it did not.
  describe("planStatus — proposed is never rendered as a commitment", () => {
    const withStatus = (planStatus: unknown, plan: unknown = {
      version: 1,
      chatId: "chat-1",
      bindings: [
        {
          vendor: "codex",
          role: "reviewer",
          fit: 0.7,
          reason: "adversarial review",
          assignedBy: "muon",
          blocked: false,
        },
      ],
      unfilled: [],
    }) =>
      loadCrewRoles({
        ...coords,
        fetcher: fetcherReturning(200, { plan, planStatus, lanes: [] }),
      });

    it("carries a proposed plan through as proposed", async () => {
      const result = await withStatus("proposed");
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.planStatus).toBe("proposed");
      expect(result.plan?.bindings).toHaveLength(1);
    });

    it("carries an assigned plan through as assigned", async () => {
      const result = await withStatus("assigned");
      if (result.status !== "ok") return;
      expect(result.planStatus).toBe("assigned");
    });

    it("reads an OLDER brain (no field) as assigned — it only ever stored plans", async () => {
      const result = await loadCrewRoles({
        ...coords,
        fetcher: fetcherReturning(200, {
          plan: {
            version: 1,
            chatId: "chat-1",
            bindings: [
              {
                vendor: "codex",
                role: "reviewer",
                fit: 0.7,
                reason: "r",
                assignedBy: "muon",
                blocked: false,
              },
            ],
            unfilled: [],
          },
          lanes: [],
        }),
      });
      if (result.status !== "ok") return;
      expect(result.planStatus).toBe("assigned");
    });

    it("downgrades an UNRECOGNIZED status to proposed rather than claiming assignment", async () => {
      // A newer brain saying something this build does not understand. The
      // weaker claim is the only safe one: a hedge costs a word, a false
      // "assigned" costs the operator's trust in the panel.
      for (const bogus of ["committed", "none", 7, {}, true]) {
        const result = await withStatus(bogus);
        if (result.status !== "ok") return;
        expect(result.planStatus, String(bogus)).toBe("proposed");
      }
    });

    it("says `none` whenever there is no plan, whatever the field claimed", async () => {
      for (const claimed of ["assigned", "proposed", undefined]) {
        const result = await withStatus(claimed, null);
        if (result.status !== "ok") return;
        expect(result.planStatus, String(claimed)).toBe("none");
        expect(result.plan).toBeNull();
      }
    });
  });

  it("treats a 404 (route absent) as a QUIET unavailable, never an error", async () => {
    const result = await loadCrewRoles({
      ...coords,
      fetcher: fetcherReturning(404, { message: "Not Found" }),
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toMatch(/not available in this brain build/i);
  });

  it("resolves (never rejects) on a thrown fetch, a timeout, or a non-JSON body", async () => {
    const thrown = await loadCrewRoles({
      ...coords,
      fetcher: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:4000");
      },
    });
    expect(thrown.status).toBe("unavailable");

    const badJson = await loadCrewRoles({
      ...coords,
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token < in JSON");
        },
      }),
    });
    expect(badJson.status).toBe("unavailable");

    const notAnObject = await loadCrewRoles({
      ...coords,
      fetcher: fetcherReturning(200, "<html>nope</html>"),
    });
    expect(notAnObject.status).toBe("unavailable");
  });

  it("drops rows it cannot validate instead of rendering a bogus role", async () => {
    const result = await loadCrewRoles({
      ...coords,
      fetcher: fetcherReturning(200, {
        plan: {
          bindings: [
            { vendor: "codex", role: "supreme-leader", fit: 9, reason: "x" },
            { role: "reviewer", fit: 0.5, reason: "no vendor" },
            {
              vendor: "codex",
              role: "reviewer",
              fit: 42,
              reason: "y".repeat(900),
              assignedBy: "definitely-not-human",
            },
          ],
          unfilled: ["qa", "not-a-role"],
        },
        lanes: [{ nope: true }, { vendor: "cursor", health: "on-fire" }],
      }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.plan?.bindings).toHaveLength(1);
    const binding = result.plan!.bindings[0]!;
    expect(binding.role).toBe("reviewer");
    // fit is clamped to 0..1 and assignedBy falls back to the safe default.
    expect(binding.fit).toBe(1);
    expect(binding.assignedBy).toBe("muon");
    expect(binding.reason.length).toBeLessThanOrEqual(400);
    expect(result.plan?.unfilled).toEqual(["qa"]);
    // An unrecognized health value is DROPPED, never rendered as a status.
    expect(result.lanes).toEqual([{ vendor: "cursor" }]);
  });

  // The module header promises "every field is re-validated here". A vendor id
  // is a lane KEY the renderer resolves a glyph and a label from, so it gets a
  // SHAPE check, not just a length clamp.
  it("re-validates vendor as an id, not as free text", async () => {
    const result = await loadCrewRoles({
      ...coords,
      fetcher: fetcherReturning(200, {
        plan: {
          bindings: [
            // Prototype names never reach the renderer as a vendor.
            { vendor: "__proto__", role: "qa", fit: 1, reason: "a" },
            { vendor: "constructor", role: "qa", fit: 1, reason: "b" },
            // Nor does anything shaped like markup, a path, or a sentence.
            { vendor: "<img src=x>", role: "qa", fit: 1, reason: "c" },
            { vendor: "../../etc/passwd", role: "qa", fit: 1, reason: "d" },
            { vendor: "claude code", role: "qa", fit: 1, reason: "e" },
            // A real id survives, case-folded to its canonical form.
            {
              vendor: "Claude-Code",
              role: "implementer",
              fit: 1,
              reason: "ok",
            },
          ],
          unfilled: [],
        },
        lanes: [
          { vendor: "__proto__" },
          { vendor: "toString" },
          { vendor: "opencode" },
        ],
      }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.plan?.bindings.map((binding) => binding.vendor)).toEqual([
      "claude-code",
    ]);
    expect(result.lanes.map((lane) => lane.vendor)).toEqual(["opencode"]);
  });

  it("marks only the failures a second attempt could clear as retryable", async () => {
    const absent = await loadCrewRoles({
      ...coords,
      fetcher: fetcherReturning(404, {}),
    });
    expect(absent).toMatchObject({ status: "unavailable" });
    // A route that is not deployed is NOT a blip — re-asking is pure waste.
    expect(
      (absent as { retryable?: boolean }).retryable ?? false
    ).toBe(false);

    for (const status of [501, 401, 403]) {
      const standing = await loadCrewRoles({
        ...coords,
        fetcher: fetcherReturning(status, {}),
      });
      expect((standing as { retryable?: boolean }).retryable ?? false).toBe(
        false
      );
    }
    for (const status of [500, 502, 429, 408]) {
      const blip = await loadCrewRoles({
        ...coords,
        fetcher: fetcherReturning(status, {}),
      });
      expect((blip as { retryable?: boolean }).retryable).toBe(true);
    }
    const offline = await loadCrewRoles({
      ...coords,
      fetcher: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:4000");
      },
    });
    expect((offline as { retryable?: boolean }).retryable).toBe(true);
  });

  it("refuses without a chat id or an api base, with no request made", async () => {
    const fetcher = vi.fn();
    expect(
      (await loadCrewRoles({ ...coords, chatId: "  ", fetcher: fetcher as never }))
        .status
    ).toBe("unavailable");
    expect(
      (await loadCrewRoles({ ...coords, apiBase: "", fetcher: fetcher as never }))
        .status
    ).toBe("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("loadCoordination — fail soft", () => {
  const snapshot = {
    version: 1,
    chatId: "chat-1",
    missionId: "root-1",
    participants: [
      {
        jobId: "job-a",
        vendor: "claude-code",
        role: "implementer",
        status: "running",
        claimedPaths: 2,
        unreadMessages: 1,
      },
    ],
    openConflicts: [
      {
        path: "src/gate.ts",
        heldByJobId: "job-a",
        heldByRole: "implementer",
        heldByVendor: "claude-code",
        expiresAt: "2026-07-25T12:20:00.000Z",
      },
    ],
    messageCount: 4,
  };

  const mission = { ...coords, missionId: "root-1" };

  /**
   * The coordination read is TWO requests: the coordinates-only snapshot, then
   * the separate operator-tier transcript. This seam answers each route on its
   * own so their failure modes can be tested independently.
   */
  function routeFetcher(
    routes: {
      coordination?: { status: number; body: unknown };
      messages?: { status: number; body: unknown };
    },
    seen: string[] = []
  ): CrewTopologyFetcher {
    return async (url) => {
      seen.push(url);
      const hit = url.includes("/api/a2a/messages")
        ? routes.messages
        : routes.coordination;
      const status = hit?.status ?? 404;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => hit?.body ?? {},
      };
    };
  }

  it("addresses BOTH routes by (chatId, missionId) and fuses snapshot + transcript", async () => {
    const seen: string[] = [];
    const result = await loadCoordination({
      ...mission,
      fetcher: routeFetcher(
        {
          coordination: { status: 200, body: { snapshot } },
          messages: {
            status: 200,
            body: {
              messages: [
                {
                  id: "m1",
                  fromJobId: "job-a",
                  fromRole: "implementer",
                  fromVendor: "claude-code",
                  to: { kind: "job", jobId: "job-b" },
                  kind: "review_request",
                  subject: "diff ready",
                  body: "look at src/gate.ts",
                  createdAt: "2026-07-25T11:59:00.000Z",
                },
              ],
            },
          },
        },
        seen
      ),
    });
    expect(seen[0]).toBe(
      "http://127.0.0.1:4000/api/a2a/coordination?chatId=chat-1&missionId=root-1"
    );
    expect(seen[1]).toMatch(
      /\/api\/a2a\/messages\?chatId=chat-1&missionId=root-1&limit=\d+$/
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.snapshot?.openConflicts).toHaveLength(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.toJobId).toBe("job-b");
    expect(result.messagesOmitted).toBe(false);
  });

  it("refuses without a missionId rather than firing a request the route would 400", async () => {
    const fetcher = vi.fn();
    const result = await loadCoordination({
      ...coords,
      fetcher: fetcher as never,
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toMatch(/no mission has been dispatched/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the snapshot when only the TRANSCRIPT fails, and says the text is missing", async () => {
    const result = await loadCoordination({
      ...mission,
      fetcher: routeFetcher({
        coordination: { status: 200, body: { snapshot } },
        messages: { status: 404, body: {} },
      }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The chart and the conflict list survive a dead transcript route.
    expect(result.snapshot?.openConflicts).toHaveLength(1);
    expect(result.snapshot?.messageCount).toBe(4);
    expect(result.messages).toEqual([]);
    expect(result.messagesOmitted).toBe(true);
  });

  // F7: `messagesOmitted` is derived from the RENDERABLE outcome, never from
  // the transport. A 200 whose body we cannot read used to yield
  // `messagesOmitted: false, messages: []` beside `messageCount: 12`, which the
  // rail rendered as "Coordination messages 12" directly above "No peer
  // messages on this mission yet."
  it("reports the text as omitted on a wrong-shape 200, not just on a dead route", async () => {
    for (const body of [
      { messages: "not-an-array" },
      { items: [] },
      {},
      // Right shape, but every row fails validation — nothing to render.
      { messages: [{ id: "m1", subject: "no body, no sender" }] },
    ]) {
      const result = await loadCoordination({
        ...mission,
        fetcher: routeFetcher({
          coordination: { status: 200, body: { snapshot } },
          messages: { status: 200, body },
        }),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;
      expect(result.messages).toEqual([]);
      expect(result.snapshot?.messageCount).toBe(4);
      // The header count is positive and nothing is renderable ⇒ say so.
      expect(result.messagesOmitted).toBe(true);
    }
  });

  it("does not claim omitted text when the mission genuinely has none", async () => {
    const result = await loadCoordination({
      ...mission,
      fetcher: routeFetcher({
        coordination: {
          status: 200,
          body: { snapshot: { ...snapshot, messageCount: 0 } },
        },
        // Even a DEAD transcript route: 0 messages exist, so there is nothing
        // the operator is being denied.
        messages: { status: 404, body: {} },
      }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messagesOmitted).toBe(false);
  });

  it("clamps untrusted agent text before it ever crosses IPC", async () => {
    const result = await loadCoordination({
      ...mission,
      fetcher: routeFetcher({
        coordination: { status: 200, body: { snapshot } },
        messages: {
          status: 200,
          body: {
            messages: [
              {
                id: "m1",
                fromJobId: "job-a",
                fromRole: "implementer",
                fromVendor: "claude-code",
                to: { kind: "job", jobId: "job-b" },
                kind: "review_request",
                subject: "s".repeat(500),
                body: "b".repeat(9000),
                createdAt: "2026-07-25T11:59:00.000Z",
              },
              // Unusable: no body. Dropped rather than half-rendered.
              {
                id: "m2",
                fromJobId: "job-a",
                fromRole: "implementer",
                fromVendor: "claude-code",
                kind: "status",
                subject: "hi",
              },
            ],
          },
        },
      }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.subject).toHaveLength(120);
    expect(result.messages[0]!.body).toHaveLength(2000);
  });

  it("falls back to `status` for an unknown message kind and null for a fan-out address", async () => {
    const result = await loadCoordination({
      ...mission,
      fetcher: routeFetcher({
        coordination: { status: 200, body: { snapshot } },
        messages: {
          status: 200,
          body: {
            messages: [
              {
                id: "m3",
                fromJobId: "job-a",
                fromRole: "scout",
                fromVendor: "codex",
                to: { kind: "crew" },
                kind: "exfiltrate",
                subject: "s",
                body: "b",
                createdAt: "2026-07-25T11:59:00.000Z",
              },
            ],
          },
        },
      }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messages[0]!.kind).toBe("status");
    expect(result.messages[0]!.toJobId).toBeNull();
  });

  it("drops a conflict it cannot attribute to both a path and a holder", async () => {
    const result = await loadCoordination({
      ...mission,
      fetcher: routeFetcher({
        coordination: {
          status: 200,
          body: {
            snapshot: {
              ...snapshot,
              openConflicts: [
                { path: "src/a.ts" },
                { heldByJobId: "job-a", heldByRole: "qa", heldByVendor: "codex" },
                {
                  path: "src/b.ts",
                  heldByJobId: "job-b",
                  heldByRole: "qa",
                  heldByVendor: "codex",
                  expiresAt: "2026-07-25T12:30:00.000Z",
                },
              ],
            },
          },
        },
        messages: { status: 200, body: { messages: [] } },
      }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.snapshot?.openConflicts.map((c) => c.path)).toEqual([
      "src/b.ts",
    ]);
  });

  it("turns a 404 / 500 / network failure into unavailable, never a rejection", async () => {
    for (const status of [404, 501, 500, 403]) {
      const result = await loadCoordination({
        ...mission,
        fetcher: routeFetcher({ coordination: { status, body: {} } }),
      });
      expect(result.status).toBe("unavailable");
    }
    const offline = await loadCoordination({
      ...mission,
      fetcher: async () => {
        throw new Error("fetch failed");
      },
    });
    expect(offline.status).toBe("unavailable");
  });

  it("aborts a hung request within its own timeout rather than hanging the panel", async () => {
    const result = await loadCoordination({
      ...mission,
      timeoutMs: 10,
      fetcher: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted"))
          );
        }),
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toMatch(/could not reach the brain/i);
  });
});
