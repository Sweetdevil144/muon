import { describe, expect, it, vi } from "vitest";
import { realpath } from "node:fs/promises";
import { MuonApiClient } from "@muon/client";
import { createToolDefinitions } from "../src/handlers.js";

// ── D14 at the AGENT surface ──────────────────────────────────────────────────
//
// `memory_preedit` is where an empty gate does the most damage: the agent reads
// `memories: []` and proceeds as if nothing had ever been decided about the code
// it is editing. This surface has TWO drops of its own on top of the gate —
// `buildAgentPreEditContext` keeps only confirmed notes, and `boundPreEditContext`
// truncates rows — so coverage must arrive, be corrected for both, and carry the
// corrective step for the reason it is empty.
//
// `preflight_edit` additionally already had a payload key called `coverage` (the
// signed changed-FILE evidence), so the gate's coverage must not shadow it.

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

const MODULE = "src/auth/guard.ts";
const CONFIRMED_ID = "mem-11111111-1111-4111-8111-111111111111";
const VOUCHED_ID = "mem-22222222-2222-4222-8222-222222222222";

const baseNote = {
  kind: "decision",
  text: "Authorization stays at the boundary",
  taskId: null,
  laneId: null,
  modules: [MODULE],
  topics: [],
  symbols: [],
  trust: "high",
  stale: false,
  status: "active",
  createdBy: "human",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
  proximity: 1,
  onTarget: true,
  onSymbol: false,
};

function wireContext(overrides: Record<string, unknown> = {}) {
  return {
    target: { module: MODULE },
    blastRadius: {
      modules: [MODULE],
      symbols: [],
      depth: 0,
      source: "provided",
    },
    memories: [],
    warnings: [],
    pendingProposals: [],
    activity: [],
    duplicateWork: [],
    coverage: {
      anchors: {
        modules: { requested: 1, resolved: 1 },
        symbols: { requested: 0, resolved: 0 },
        unreadable: 0,
      },
      notes: { considered: 32, admitted: 0, surfaced: 0 },
      admittedBy: { humanConfirmed: 0, crewVouched: 0, trustFloor: 0 },
      crewChat: true,
      emptyReason: "withheld_by_gate",
    },
    ...overrides,
  };
}

/** The finalized agent-facing next actions (`ok`'s hints are folded into
 *  `_muon` by the contract wrapper, and that is where an agent reads them). */
function nextActionsOf(result: { content: { text: string }[] }): string {
  const payload = JSON.parse(result.content[0]!.text) as {
    _muon?: { nextActions?: string[] };
  };
  return (payload._muon?.nextActions ?? []).join("\n");
}

function preeditTool(
  fetcher: typeof fetch,
  scope: Record<string, unknown> = { taskId: "task-1", laneKey: "codex" }
) {
  const client = new MuonApiClient("http://localhost:4000", fetcher);
  const tool = createToolDefinitions(client, scope as never).find(
    (candidate) => candidate.name === "memory_preedit"
  );
  if (!tool) throw new Error("memory_preedit not found");
  return tool;
}

describe("memory_preedit carries D14 coverage to the agent", () => {
  it("puts the counts and the closed-enum reason on the payload", async () => {
    const fetcher = vi.fn(async (url: string) =>
      String(url).endsWith("/api/memory/preedit")
        ? mockResponse(wireContext())
        : mockResponse({ buffered: 0 }, 202)
    );
    const tool = preeditTool(fetcher as never, {});
    const result = await tool.handler({ module: MODULE });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.coverage.notes.considered).toBe(32);
    expect(payload.coverage.emptyReason).toBe("withheld_by_gate");
    // Same block under `context`, which is what preflight_edit re-exports.
    expect(payload.context.coverage.emptyReason).toBe("withheld_by_gate");
  });

  it("attaches the CORRECTIVE step for the reason, so an empty gate is never just silence", async () => {
    const fetcher = vi.fn(async (url: string) =>
      String(url).endsWith("/api/memory/preedit")
        ? mockResponse(wireContext())
        : mockResponse({ buffered: 0 }, 202)
    );
    const tool = preeditTool(fetcher as never, {});
    const result = await tool.handler({ module: MODULE });
    // `finalize` folds the hints into `_muon`, which is what the agent reads.
    const nextActions = nextActionsOf(result);
    expect(nextActions).toMatch(/none passed the gate/i);
    expect(nextActions).toMatch(/unbriefed, not as decided/i);
  });

  it("re-stamps `surfaced` for what the CONFIRMED-ONLY projection withheld (the silent drop)", async () => {
    // The gate admitted two crew-vouched notes. The agent projection keeps only
    // confirmed ones, so this tool shows zero — the case that produced no signal
    // at all before D14.
    const fetcher = vi.fn(async (url: string) =>
      String(url).endsWith("/api/memory/preedit")
        ? mockResponse(
            wireContext({
              memories: [
                { ...baseNote, id: CONFIRMED_ID, confirmed: false },
                { ...baseNote, id: VOUCHED_ID, confirmed: false },
              ],
              coverage: {
                anchors: {
                  modules: { requested: 1, resolved: 1 },
                  symbols: { requested: 0, resolved: 0 },
                  unreadable: 0,
                },
                notes: { considered: 32, admitted: 2, surfaced: 2 },
                admittedBy: {
                  humanConfirmed: 0,
                  crewVouched: 2,
                  trustFloor: 0,
                },
                crewChat: true,
              },
            })
          )
        : mockResponse({ buffered: 0 }, 202)
    );
    const tool = preeditTool(fetcher as never, {});
    const result = await tool.handler({ module: MODULE });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.memories).toEqual([]);
    expect(payload.coverage.notes.surfaced).toBe(0);
    // The gate's own answer survives — that is what makes the drop legible.
    expect(payload.coverage.notes.admitted).toBe(2);
    expect(payload.coverage.admittedBy.crewVouched).toBe(2);
    expect(payload.coverage.emptyReason).toBe("withheld_agent_projection");
    expect(nextActionsOf(result)).toMatch(/confirmed-only surface withheld/i);
  });

  it("keeps `surfaced` equal to the memories it actually emitted, and leaks no ids or coordinates", async () => {
    const fetcher = vi.fn(async (url: string) =>
      String(url).endsWith("/api/memory/preedit")
        ? mockResponse(
            wireContext({
              memories: [{ ...baseNote, id: CONFIRMED_ID, confirmed: true }],
              coverage: {
                anchors: {
                  modules: { requested: 1, resolved: 1 },
                  symbols: { requested: 0, resolved: 0 },
                  unreadable: 0,
                },
                notes: { considered: 4, admitted: 1, surfaced: 1 },
                admittedBy: {
                  humanConfirmed: 1,
                  crewVouched: 0,
                  trustFloor: 0,
                },
                crewChat: false,
              },
            })
          )
        : mockResponse({ buffered: 0 }, 202)
    );
    const tool = preeditTool(fetcher as never, {});
    const result = await tool.handler({ module: MODULE });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.memories).toHaveLength(1);
    expect(payload.coverage.notes.surfaced).toBe(1);
    expect(payload.coverage.emptyReason).toBeUndefined();
    expect(JSON.stringify(payload.coverage)).not.toContain(CONFIRMED_ID);
    expect(JSON.stringify(payload.coverage)).not.toContain(MODULE);
    // No coverage-derived advice on a non-empty read.
    expect(nextActionsOf(result)).not.toMatch(/muon doctor/);
  });

  it("follows the ROW BOUND: `surfaced` counts the rows actually emitted, not the rows admitted", async () => {
    // PREEDIT_ROW_LIMIT is 20. Admit 25 and the tool emits 20, so a coverage block
    // that kept saying 25 would over-claim by exactly the omitted rows.
    const many = Array.from({ length: 25 }, (_, index) => ({
      ...baseNote,
      // Valid mem-<uuid v4> ids, distinct per row (the projection requires them).
      id: `mem-4${index.toString(16).padStart(7, "0")}-1111-4111-8111-111111111111`,
      confirmed: true,
    }));
    const fetcher = vi.fn(async (url: string) =>
      String(url).endsWith("/api/memory/preedit")
        ? mockResponse(
            wireContext({
              memories: many,
              coverage: {
                anchors: {
                  modules: { requested: 1, resolved: 1 },
                  symbols: { requested: 0, resolved: 0 },
                  unreadable: 0,
                },
                notes: { considered: 40, admitted: 25, surfaced: 25 },
                admittedBy: {
                  humanConfirmed: 25,
                  crewVouched: 0,
                  trustFloor: 0,
                },
                crewChat: false,
              },
            })
          )
        : mockResponse({ buffered: 0 }, 202)
    );
    const tool = preeditTool(fetcher as never, {});
    const result = await tool.handler({ module: MODULE });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.memories).toHaveLength(20);
    expect(payload.coverage.notes.surfaced).toBe(20);
    expect(payload.coverage.notes.admitted).toBe(25);
    // Still not empty at this surface, so no reason is invented.
    expect(payload.coverage.emptyReason).toBeUndefined();
  });

  it("stays silent (no fabricated block) against a PRE-D14 backend", async () => {
    const { coverage: _dropped, ...noCoverage } = wireContext();
    const fetcher = vi.fn(async (url: string) =>
      String(url).endsWith("/api/memory/preedit")
        ? mockResponse(noCoverage)
        : mockResponse({ buffered: 0 }, 202)
    );
    const tool = preeditTool(fetcher as never, {});
    const result = await tool.handler({ module: MODULE });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage).toBeUndefined();
  });
});

describe("preflight_edit does not let two things be called 'coverage'", () => {
  it("exposes the gate's coverage as `memoryCoverage` while `coverage` stays the signed FILE evidence", async () => {
    const root = await realpath(process.cwd());
    const head = "abc1234";
    // Same GitNexus stub shape handlers.test.ts uses for the happy path: git
    // head/common-dir, an indexed repo at this root, an exact symbol, then impact.
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") {
        return {
          stdout: args.includes("--git-common-dir")
            ? `${root}/.git\n`
            : `${head}\n`,
          stderr: "",
        };
      }
      if (args[0] === "list") {
        return {
          stdout: [
            "  Indexed Repositories (1)",
            "  muon",
            `    Path:    ${root}`,
            `    Commit:  ${head}`,
          ].join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "context") {
        return {
          stdout: JSON.stringify({
            status: "found",
            symbol: {
              uid: "Function:src/auth/guard.ts:authorize",
              name: "authorize",
              kind: "Function",
              filePath: "src/auth/guard.ts",
            },
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          target: {
            id: "Function:src/auth/guard.ts:authorize",
            name: "authorize",
            type: "Function",
            filePath: "src/auth/guard.ts",
          },
          risk: "LOW",
          affected_modules: [],
          byDepth: {},
        }),
        stderr: "",
      };
    });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/memory/preedit")) {
        return mockResponse(wireContext());
      }
      if (String(url).endsWith("/api/events")) {
        const body = JSON.parse(String(init?.body));
        return mockResponse({
          event: {
            id: "event-preflight-coverage",
            ...body,
            timestamp: "2026-07-30T10:00:00.000Z",
          },
        });
      }
      return mockResponse({ buffered: 0 }, 202);
    });
    const client = new MuonApiClient("http://localhost:4000", fetcher as never);
    const tool = createToolDefinitions(
      client,
      {
        taskId: "task-1",
        laneKey: "codex",
        jobId: "job-1",
        preflightNonce: "runner-only-secret",
      },
      { gitNexus: { workspacePath: root, binary: "gitnexus", run } }
    ).find((candidate) => candidate.name === "preflight_edit")!;

    const result = await tool.handler({
      target: "authorize",
      filePath: "src/auth/guard.ts",
      kind: "Function",
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text);

    // `coverage` keeps its established meaning: the signed changed-file evidence.
    expect(payload.coverage.coveredFiles).toEqual(["src/auth/guard.ts"]);
    expect(payload.coverage.jobId).toBe("job-1");
    expect(payload.coverage.risk).toBe("LOW");
    // The gate's coverage rides its own key, and is not lost in the composition.
    expect(payload.memoryCoverage.emptyReason).toBe("withheld_by_gate");
    expect(payload.memoryCoverage.notes.considered).toBe(32);
    // …and the composed read's emptiness is actionable, not silent.
    expect(nextActionsOf(result)).toMatch(/unbriefed, not as decided/i);
  });
});
