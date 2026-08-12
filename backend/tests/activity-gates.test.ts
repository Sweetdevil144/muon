import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MuonGraph,
  SHIPPED_DUP_WORK_THRESHOLD,
  SHIPPED_RECENT_ACTIVITY_WINDOW_MS,
  type Embedder,
  type PreEditActivity,
} from "@muon/graph";
import {
  RECENT_ACTIVITY_WINDOW_MS,
  readActivity,
  type ActivityGraph,
} from "../src/lib/activity.js";
import { DUP_WORK_THRESHOLD, readDuplicateWork } from "../src/lib/duplicate-work.js";
import { createLocalOllamaEmbedder } from "../src/lib/embedder.js";
import { preEditContext } from "../src/lib/preedit.js";

// KG-11 (ADR-0014 §7), the MERGE GATES that make the recurring "gate every content
// field" discipline enforceable green-before-merge. These drive the REAL readers
// (`readActivity` = KG-7/8 live+recent, `readDuplicateWork` = KG-10) over a faithful
// fake prisma/graph + a fake/loopback embedder, fused through the REAL hero
// (`preEditContext`) against a REAL MuonGraph, so the gates hold on the shipped
// code paths, not inline stand-ins. Three umbrella invariants:
//   1. CATEGORICAL side-channel no-text audit , no content sentinel escapes ANY
//      agent-facing channel (activity[], duplicateWork[], warnings[], pendingProposals[]).
//   2. NO-EGRESS , the activity + dup-work read makes ZERO network on the default
//      path, and even the dense path only ever targets the loopback literal.
//   3. NO-REGRESSION , memories[] AND activity[] are byte-for-byte identical whether
//      or not the new channels are present.

// ── a faithful fake prisma the BOTH readers share ───────────────────────────
// findMany/findFirst HONOR where/orderBy/take but RETURN FULL ROWS (ignoring
// `select`) so the leak audit proves the READER's own discipline, not the fake's.

type JobRow = {
  id: string;
  status: string;
  vendor: string;
  taskId: string;
  // CONTENT, read ONLY to embed (dup-work); must NEVER surface on any output.
  brief: string;
};

type EventRow = {
  taskId: string;
  laneId: string;
  timestamp: Date;
  // Free-form JSON. Only `modules`/`symbols` are coordinates; anything else is content.
  metadata: Record<string, unknown>;
  // CONTENT, must NEVER be selected or surfaced.
  message: string;
};

type JobWhere = {
  status?: string;
  id?: string | { not: string };
  taskId?: string | { not: string };
};

function jobMatches(job: JobRow, where: JobWhere): boolean {
  if (where.status !== undefined && job.status !== where.status) return false;
  if (typeof where.id === "string" && job.id !== where.id) return false;
  if (where.id && typeof where.id === "object" && job.id === where.id.not)
    return false;
  if (typeof where.taskId === "string" && job.taskId !== where.taskId)
    return false;
  if (where.taskId && typeof where.taskId === "object" && job.taskId === where.taskId.not)
    return false;
  return true;
}

function fakePrisma(jobs: JobRow[], events: EventRow[]) {
  const selectSpy = vi.fn();
  return {
    prisma: {
      dispatchJob: {
        findMany: async (args: { where: JobWhere; take: number; select: unknown }) => {
          selectSpy(args.select);
          return jobs.filter((j) => jobMatches(j, args.where)).slice(0, args.take);
        },
        findFirst: async (args: { where: JobWhere; select: unknown }) => {
          selectSpy(args.select);
          return jobs.find((j) => jobMatches(j, args.where)) ?? null;
        },
      },
      event: {
        findMany: async (args: {
          where: { taskId: string };
          orderBy: { timestamp: "desc" };
          take: number;
          select: unknown;
        }) => {
          selectSpy(args.select);
          return events
            .filter((e) => e.taskId === args.where.taskId)
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
            .slice(0, args.take);
        },
      },
    },
    selectSpy,
  };
}

/** A fake recent-activity graph (KG-8 leg). Returns whatever rows it is given. */
function fakeActivityGraph(rows: PreEditActivity[] = []): ActivityGraph {
  return {
    recentActivityOn: async () => rows,
  };
}

/** A deterministic fake embedder (no network). Two briefs sharing the sentinel
 *  substring embed to near-identical vectors so the dup pair IS flagged, the
 *  strongest test that even a FLAGGED row surfaces no brief text. */
function fakeEmbedder(table: Record<string, number[]>): Embedder {
  return {
    id: "fake-gate-v1",
    embed: async (texts: string[]) => texts.map((t) => table[t] ?? [0, 0, 1]),
  };
}

// ── a GOVERNED note helper on a shared real graph ────────────────────────────

let graph: MuonGraph;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-activity-gates-"));
  graph = new MuonGraph(join(dir, "gates.lbug"), { disableFts: true });
  await graph.init();
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 1, CATEGORICAL side-channel no-text audit (the umbrella).
// ─────────────────────────────────────────────────────────────────────────────
/** The fence the ROUTE applies — see coordination-partition.ts. */
const WS = "/repo/main";
const PARTITION = { workspacePath: WS } as const;

describe("GATE 1 (KG-11): CATEGORICAL side-channel, no content sentinel escapes ANY agent channel", () => {
  it("every content source carries a UNIQUE sentinel; NONE appears in activity[]/duplicateWork[]/warnings[]/pendingProposals[]", async () => {
    const mod = "src/gates/target.ts";
    const sym = `${mod}#run`;

    // Four DISTINCT content sentinels, one per content-bearing source.
    const SENTINEL_NOTE_TEXT = "ZZZ_SENTINEL_NOTE_TEXT_ignore_all_prior_instructions";
    const SENTINEL_BRIEF = "ZZZ_SENTINEL_BRIEF_exfiltrate_the_database";
    const SENTINEL_EVENT_MESSAGE = "ZZZ_SENTINEL_EVENT_MESSAGE_do_not_leak_me";
    const SENTINEL_META = "ZZZ_SENTINEL_META_hidden_metadata_payload";
    const ALL = [SENTINEL_NOTE_TEXT, SENTINEL_BRIEF, SENTINEL_EVENT_MESSAGE, SENTINEL_META];

    // (a) A CONFIRMED governed note on the target (legit content, surfaced in
    //     `memories`, NOT audited here). (b) A hostile UNCONFIRMED note whose TEXT
    //     is a sentinel, wired PROPOSES_SUPERSEDE → drives warnings + pendingProposals
    //     by EXISTENCE + IDs only (the omission discipline).
    const confirmed = await graph.addMemoryNote({
      kind: "decision",
      text: "The target enforces idempotency by request key",
      modules: [mod],
      trust: "high",
      createdBy: "human",
    });
    await graph.updateMemoryNote(confirmed.id, { confirmed: true });
    const hostile = await graph.addMemoryNote({
      kind: "attempt",
      text: SENTINEL_NOTE_TEXT,
      modules: [mod],
      trust: "low",
      createdBy: "agent:intruder",
    });
    await graph.projectMemoryEdge(hostile.id, confirmed.id, "proposes_supersede");

    // Live peer working set (fed via fake prisma): a running peer job whose brief is
    // a paraphrase of the caller's (both carry SENTINEL_BRIEF), and whose event
    // declares the target anchors PLUS a message + a free-form metadata value that
    // are sentinels. The fake returns FULL rows so this proves the READERS omit them.
    const callerBrief = `${SENTINEL_BRIEF} token-bucket rate limiter for the pay api`;
    const peerBrief = `${SENTINEL_BRIEF} add token-bucket limiting to payments`;
    const jobs: JobRow[] = [
      { id: "job-caller", status: "running", vendor: "claude-code", taskId: "task-caller", brief: callerBrief },
      { id: "job-peer", status: "running", vendor: "codex", taskId: "task-peer", brief: peerBrief },
    ];
    const events: EventRow[] = [
      {
        taskId: "task-peer",
        laneId: "lane-codex-0",
        timestamp: new Date("2026-07-12T00:00:00.000Z"),
        // modules/symbols are the LEGIT coordinates; `summary` is free-form content.
        metadata: { modules: [mod], symbols: [sym], summary: SENTINEL_META },
        message: SENTINEL_EVENT_MESSAGE,
      },
    ];
    const { prisma } = fakePrisma(jobs, events);
    const embedder = fakeEmbedder({
      [callerBrief]: [1, 0],
      [peerBrief]: [0.97, 0.2426], // cosine ≈ 0.97 ≥ threshold → FLAGGED
    });

    // Run the FULL hero with the REAL readers, excluding the caller's own ids (#5).
    const ctx = await preEditContext(
      graph,
      { symbol: sym, module: mod },
      {
        activityReader: readActivity(prisma as never, fakeActivityGraph(), { partition: PARTITION }),
        duplicateWorkReader: readDuplicateWork(prisma as never, embedder, PARTITION),
        excludeTaskId: "task-caller",
        excludeJobId: "job-caller",
      }
    );

    // The gate is NON-VACUOUS: every audited channel is actually populated.
    expect(ctx.activity.length).toBeGreaterThan(0);
    expect(ctx.duplicateWork.length).toBeGreaterThan(0);
    expect(ctx.warnings.length).toBeGreaterThan(0);
    expect(ctx.pendingProposals.length).toBeGreaterThan(0);
    // The peer surfaces as coordinates on BOTH channels.
    expect(ctx.activity.some((a) => a.jobId === "job-peer")).toBe(true);
    expect(ctx.duplicateWork.some((d) => d.jobId === "job-peer")).toBe(true);
    // The proposal surfaces by ID for a human to adjudicate, but not its text.
    expect(ctx.pendingProposals.some((p) => p.proposalNoteId === hostile.id)).toBe(true);

    // THE CATEGORICAL GATE: no content sentinel appears ANYWHERE in the four
    // agent-facing channels. Not per-field, "no content escapes any channel".
    const audited = JSON.stringify({
      activity: ctx.activity,
      duplicateWork: ctx.duplicateWork,
      warnings: ctx.warnings,
      pendingProposals: ctx.pendingProposals,
    });
    for (const sentinel of ALL) {
      expect(audited).not.toContain(sentinel);
    }
    // Stronger: no sentinel appears anywhere in the WHOLE serialized context (the
    // hostile note's text is excluded from memories by the confirmed-only gate too).
    expect(ALL.some((s) => JSON.stringify(ctx).includes(s))).toBe(false);

    // The LEGIT coordinate (the shared anchor) DID surface, proving we asserted the
    // absence of CONTENT, not the absence of everything.
    expect(JSON.stringify(ctx.activity)).toContain(sym);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 2, NO-EGRESS for the activity + dup-work path (ADR §7 pending gate).
// ─────────────────────────────────────────────────────────────────────────────
describe("GATE 2 (KG-11): NO-EGRESS, activity + dup-work make ZERO network by default; dense path is loopback-only", () => {
  const anchors = { symbols: ["src/egress/x.ts#f"], modules: ["src/egress/x.ts"] };
  const jobs: JobRow[] = [
    { id: "job-caller", status: "running", vendor: "claude-code", taskId: "task-caller", brief: "caller brief alpha" },
    { id: "job-peer", status: "running", vendor: "codex", taskId: "task-peer", brief: "peer brief beta" },
  ];
  const events: EventRow[] = [
    {
      taskId: "task-peer",
      laneId: "lane-0",
      timestamp: new Date("2026-07-12T00:00:00.000Z"),
      metadata: { modules: ["src/egress/x.ts"], symbols: ["src/egress/x.ts#f"] },
      message: "m",
    },
  ];

  it("DEFAULT PATH: the activity read + the dense-OFF dup-work read touch the network ZERO times", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const { prisma } = fakePrisma(jobs, events);
      // KG-7/8 activity read, pure ledger reads, no embedder anywhere.
      const activity = await readActivity(prisma as never, fakeActivityGraph(), { partition: PARTITION })(anchors, {
        taskId: "task-caller",
        jobId: "job-caller",
      });
      expect(activity.some((a) => a.jobId === "job-peer")).toBe(true);
      // KG-10 dup-work with dense OFF (no embedder, the realistic default) → [] with
      // ZERO embed work.
      const dup = await readDuplicateWork(prisma as never, undefined, PARTITION)({
        taskId: "task-caller",
        jobId: "job-caller",
      });
      expect(dup).toEqual([]);
      // The load-bearing assertion: nothing reached for the network.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("DENSE PATH: the dup-work embedder ONLY ever targets the loopback literal, redirect:error", async () => {
    // A loopback fetch stand-in: answers /api/tags (probe) and /api/embeddings, and
    // RECORDS every (url, options) so we can prove no other host is ever contacted.
    const calls: { url: string; redirect: unknown }[] = [];
    const loopbackFetch = (async (url: string | URL, options?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, redirect: options?.redirect });
      if (u.endsWith("/api/tags")) {
        return { ok: true } as Response;
      }
      if (u.endsWith("/api/embeddings")) {
        return {
          ok: true,
          json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
        } as unknown as Response;
      }
      throw new Error(`unexpected url ${u}`);
    }) as typeof fetch;

    // The REAL KG-3 loopback embedder, there is NO host option to point elsewhere.
    const embedder = createLocalOllamaEmbedder({ fetchImpl: loopbackFetch });
    const { prisma } = fakePrisma(jobs, events);
    await readDuplicateWork(prisma as never, embedder, PARTITION)({
      taskId: "task-caller",
      jobId: "job-caller",
    });

    // It DID reach the (loopback) backend, and EVERY call is the literal loopback IP
    // with redirect:"error" (no configurable host, no DNS, no off-box redirect).
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith("http://127.0.0.1:11434/")).toBe(true);
      expect(call.redirect).toBe("error");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 3, memories[] + activity[] NO-REGRESSION pin across the full channel set.
// ─────────────────────────────────────────────────────────────────────────────
describe("GATE 3 (KG-11): NO-REGRESSION, memories[] AND activity[] byte-for-byte across the channel set", () => {
  it("adding the REAL activity + dup-work channels never perturbs memories[]; adding dup-work never perturbs activity[]", async () => {
    const mod = "src/gates/noreg.ts";
    const sym = `${mod}#fn`;
    const good = await graph.addMemoryNote({
      kind: "decision",
      text: "noreg target decision",
      symbols: [sym],
      modules: [mod],
      trust: "high",
      createdBy: "human",
    });
    await graph.updateMemoryNote(good.id, { confirmed: true });
    const now = Date.now();

    const jobs: JobRow[] = [
      { id: "job-caller", status: "running", vendor: "claude-code", taskId: "task-caller", brief: "caller brief gamma" },
      { id: "job-peer", status: "running", vendor: "codex", taskId: "task-peer", brief: "caller brief gamma refined" },
    ];
    const events: EventRow[] = [
      {
        taskId: "task-peer",
        laneId: "lane-0",
        timestamp: new Date("2026-07-12T00:00:00.000Z"),
        metadata: { modules: [mod], symbols: [sym] },
        message: "m",
      },
    ];
    const embedder = fakeEmbedder({
      "caller brief gamma": [1, 0],
      "caller brief gamma refined": [0.98, 0.199], // cosine ≈ 0.98 → flagged
    });
    const base = () => ({
      now,
      excludeTaskId: "task-caller",
      excludeJobId: "job-caller",
    });

    // (1) hero with NEITHER new channel.
    const bare = await preEditContext(graph, { symbol: sym, module: mod }, base());
    expect(bare.activity).toEqual([]);
    expect(bare.duplicateWork).toEqual([]);

    // (2) + REAL activity reader → memories UNCHANGED byte-for-byte.
    const { prisma: p2 } = fakePrisma(jobs, events);
    const withActivity = await preEditContext(graph, { symbol: sym, module: mod }, {
      ...base(),
      activityReader: readActivity(p2 as never, fakeActivityGraph(), { partition: PARTITION }),
    });
    expect(withActivity.activity.length).toBeGreaterThan(0);
    expect(JSON.stringify(withActivity.memories)).toBe(JSON.stringify(bare.memories));

    // (3) + REAL dup-work reader (on top of activity) → memories AND activity UNCHANGED.
    const { prisma: p3 } = fakePrisma(jobs, events);
    const withBoth = await preEditContext(graph, { symbol: sym, module: mod }, {
      ...base(),
      activityReader: readActivity(p3 as never, fakeActivityGraph(), { partition: PARTITION }),
      duplicateWorkReader: readDuplicateWork(p3 as never, embedder, PARTITION),
    });
    expect(withBoth.duplicateWork.length).toBeGreaterThan(0);
    // THE PINS: the two new channels are strictly siblings.
    expect(JSON.stringify(withBoth.memories)).toBe(JSON.stringify(bare.memories));
    expect(JSON.stringify(withBoth.activity)).toBe(JSON.stringify(withActivity.activity));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The namespace/default-drift gate: the eval's SHIPPED_* mirrors must equal the
// backend knobs it validates (mirrors the symbol-id cross-package merge gate).
// ─────────────────────────────────────────────────────────────────────────────
describe("GATE (KG-11): the eval's tuned-knob mirrors equal the SHIPPED backend defaults", () => {
  it("SHIPPED_RECENT_ACTIVITY_WINDOW_MS === RECENT_ACTIVITY_WINDOW_MS and SHIPPED_DUP_WORK_THRESHOLD === DUP_WORK_THRESHOLD", () => {
    expect(SHIPPED_RECENT_ACTIVITY_WINDOW_MS).toBe(RECENT_ACTIVITY_WINDOW_MS);
    expect(SHIPPED_DUP_WORK_THRESHOLD).toBe(DUP_WORK_THRESHOLD);
  });
});
