import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyFlakiness } from "@muon/protocol";

// ADR-0037 — reading a check's history from what MUON already records.
//
// The property under test is the partition fence: history is keyed
// (workspacePath, check name), so one repository's `npm test` record can never
// be reported as evidence about another's. Same class of leak ADR-0026 closes
// for memory, and an unfenced read here would be worse than no history.

const REPO_A = "/repos/alpha";
const REPO_B = "/repos/beta";

let dir: string;
let db: typeof import("../src/lib/db.js");
let read: typeof import("../src/lib/check-history-read.js");

/** A finished job carrying a typed packet with one named check outcome. */
async function job(
  id: string,
  workspacePath: string,
  checks: { name: string; outcome: string }[],
  createdAt: Date
): Promise<void> {
  await db.prisma.dispatchJob.create({
    data: {
      id,
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-hist",
      brief: "b",
      status: "done",
      workspacePath,
      dispatchedBy: "human",
      createdAt,
      endedAt: createdAt,
      packetJson: { checks } as never,
    },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-checkhist-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  vi.resetModules();

  db = await import("../src/lib/db.js");
  await db.ensureSchema();
  read = await import("../src/lib/check-history-read.js");

  await db.prisma.task.create({
    data: {
      id: "task-hist",
      title: "History",
      description: "d",
      status: "in_progress",
      workspacePath: REPO_A,
    },
  });

  const base = Date.parse("2026-08-01T00:00:00.000Z");
  const at = (n: number) => new Date(base + n * 60_000);

  // Repo A: `npm test` failed once in four runs — the field notes' exact case.
  await job("a1", REPO_A, [{ name: "npm test", outcome: "passed" }], at(1));
  await job("a2", REPO_A, [{ name: "npm test", outcome: "failed" }], at(2));
  await job("a3", REPO_A, [{ name: "npm test", outcome: "passed" }], at(3));
  await job("a4", REPO_A, [{ name: "npm test", outcome: "passed" }], at(4));
  // …and a check that has only ever failed.
  await job("a5", REPO_A, [{ name: "npm run lint", outcome: "failed" }], at(5));
  await job("a6", REPO_A, [{ name: "npm run lint", outcome: "failed" }], at(6));
  await job("a7", REPO_A, [{ name: "npm run lint", outcome: "failed" }], at(7));

  // Repo B: the SAME check name, all green. It must never colour repo A.
  for (let n = 0; n < 6; n += 1) {
    await job(`b${n}`, REPO_B, [{ name: "npm test", outcome: "passed" }], at(10 + n));
  }

  // A job whose packet is malformed/legacy — must be skipped, not throw.
  await db.prisma.dispatchJob.create({
    data: {
      id: "a-bad",
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-hist",
      brief: "b",
      status: "done",
      workspacePath: REPO_A,
      dispatchedBy: "human",
      packetJson: { checks: "not-an-array" } as never,
    },
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("history is read from what MUON already records", () => {
  it("recovers a check's outcomes from stored packets", async () => {
    const { byName } = await read.readCheckHistory(REPO_A);
    const runs = byName.get("npm test") ?? [];
    expect(runs).toHaveLength(4);
    expect(runs.map((r) => r.outcome)).toEqual([
      "passed",
      "failed",
      "passed",
      "passed",
    ]);
  });

  it("classifies the field notes' case exactly", async () => {
    const { byName } = await read.readCheckHistory(REPO_A);
    const verdict = classifyFlakiness(byName.get("npm test") ?? []);
    expect(verdict.kind).toBe("flaky");
    expect(verdict.failures).toBe(1);
    expect(verdict.runs).toBe(4);
  });

  it("keeps an always-failing check OUT of the flaky bucket", async () => {
    const { byName } = await read.readCheckHistory(REPO_A);
    expect(classifyFlakiness(byName.get("npm run lint") ?? []).kind).toBe(
      "consistently-failing"
    );
  });
});

describe("ADR-0037 D5 — the workspace fence", () => {
  it("never lets one repo's history speak for another's", async () => {
    // Repo B's `npm test` is 6-of-6 green. If the fence leaked, repo A's
    // identically-named check would look stable instead of flaky.
    const a = (await read.readCheckHistory(REPO_A)).byName;
    const b = (await read.readCheckHistory(REPO_B)).byName;
    expect(classifyFlakiness(a.get("npm test") ?? []).kind).toBe("flaky");
    expect(classifyFlakiness(b.get("npm test") ?? []).kind).toBe("stable");
    // The run's workspace is now stamped FROM THE ROW, so this assertion has
    // teeth: it used to copy the function argument and was true by
    // construction even with the fence removed.
    expect((a.get("npm test") ?? []).every((r) => r.workspacePath === REPO_A)).toBe(
      true
    );
  });

  it("returns nothing for an unknown workspace, rather than everything", async () => {
    const { byName } = await read.readCheckHistory("/repos/never-seen");
    expect(byName.size).toBe(0);
  });

  it("returns nothing when no workspace is known", async () => {
    expect((await read.readCheckHistory(null)).byName.size).toBe(0);
    expect((await read.readCheckHistory(undefined)).byName.size).toBe(0);
  });
});

describe("a malformed packet is skipped, never fatal", () => {
  it("ignores a row whose checks are not an array", async () => {
    // Stored JSON: a legacy or corrupt row must yield no history rather than
    // throw inside a packet build. A history that cannot be read is a history
    // not shown — never a failed job.
    const { byName } = await read.readCheckHistory(REPO_A);
    expect(byName.get("npm test")).toHaveLength(4);
    expect(byName.has("not-an-array")).toBe(false);
  });
});

describe("the lookup defaults safely", () => {
  it("gives an unseen check an empty history, which reads as insufficient-evidence", async () => {
    // A check MUON has never seen must not read as `stable`.
    const { byName } = await read.readCheckHistory(REPO_A);
    const lookup = read.historyLookup(byName);
    expect(lookup("a check nobody has run")).toEqual([]);
    expect(classifyFlakiness(lookup("a check nobody has run")).kind).toBe(
      "insufficient-evidence"
    );
  });
});

// The function actually wired into the task-detail route. It had NO tests at
// all, and both of the review's confirmed defects lived here.
describe("annotateHandoffChecks", () => {
  it("is LENGTH-PRESERVING — a malformed entry is kept, not deleted", async () => {
    // The defect: an earlier version used .filter() and made the result the
    // replacement array, silently dropping entries INCLUDING their
    // outcome: "failed". Worse than the downgrade D1 forbids.
    const handoffs = [
      {
        packetJson: {
          checks: [
            { name: "npm test", outcome: "failed" },
            { outcome: "failed" },
            { name: 123, outcome: "failed" },
          ],
        },
      },
    ];
    const [out] = await read.annotateHandoffChecks(handoffs, REPO_A);
    const checks = (out!.packetJson as { checks: unknown[] }).checks;
    expect(checks).toHaveLength(3);
    expect(
      checks.every((c) => (c as { outcome?: string }).outcome === "failed")
    ).toBe(true);
  });

  it("never lets a packet forge its own flakiness — annotated path", async () => {
    const [out] = await read.annotateHandoffChecks(
      [
        {
          packetJson: {
            checks: [
              {
                name: "npm run lint",
                outcome: "failed",
                flakiness: { kind: "flaky", runs: 20, failures: 1 },
                flakinessNote: "known-flaky: failed 1 of 20 recorded runs",
              },
            ],
          },
        },
      ],
      REPO_A
    );
    const [check] = (out!.packetJson as { checks: Record<string, unknown>[] })
      .checks;
    expect((check!.flakiness as { kind: string }).kind).toBe(
      "consistently-failing"
    );
    expect(String(check!.flakinessNote)).not.toContain("known-flaky");
  });

  it("strips a forged flakiness even when NO history is available", async () => {
    const forged = {
      packetJson: {
        checks: [
          {
            name: "npm test",
            outcome: "failed",
            flakiness: { kind: "flaky", runs: 99, failures: 1 },
            flakinessNote: "known-flaky: failed 1 of 99 recorded runs",
          },
        ],
      },
    };
    for (const workspace of [null, undefined, "/repos/never-seen"]) {
      const [out] = await read.annotateHandoffChecks([forged], workspace);
      expect(JSON.stringify(out), String(workspace)).not.toContain("99");
      const [check] = (out!.packetJson as { checks: Record<string, unknown>[] })
        .checks;
      expect(check!.outcome, String(workspace)).toBe("failed");
    }
  });

  it("strips a forged flakiness when the packet has no checks array", async () => {
    const [out] = await read.annotateHandoffChecks(
      [{ packetJson: { checks: "not-an-array" } }],
      REPO_A
    );
    expect(out!.packetJson).toMatchObject({ checks: "not-an-array" });
  });

  it("never changes an outcome", async () => {
    const [out] = await read.annotateHandoffChecks(
      [{ packetJson: { checks: [{ name: "npm run lint", outcome: "failed" }] } }],
      REPO_A
    );
    const [check] = (out!.packetJson as { checks: Record<string, unknown>[] })
      .checks;
    expect(check!.outcome).toBe("failed");
  });
});

describe("the scan budget cannot be used to erase a history", () => {
  it("ignores non-terminal jobs, so cheap dispatches cannot starve the scan", async () => {
    // An agent could otherwise queue 60 packet-less jobs and make every check
    // in the workspace read `insufficient-evidence`, erasing a
    // `consistently-failing` label from the operator's screen.
    expect(
      (await read.readCheckHistory(REPO_A)).byName.get("npm run lint")
    ).toHaveLength(3);

    for (let n = 0; n < 70; n += 1) {
      await db.prisma.dispatchJob.create({
        data: {
          id: `noise-${n}`,
          kind: "oneshot",
          vendor: "codex",
          taskId: "task-hist",
          brief: "b",
          status: "queued",
          workspacePath: REPO_A,
          dispatchedBy: "agent:job:x",
        },
      });
    }

    const after = (await read.readCheckHistory(REPO_A)).byName;
    expect(after.get("npm run lint")).toHaveLength(3);
    expect(classifyFlakiness(after.get("npm run lint") ?? []).kind).toBe(
      "consistently-failing"
    );
  });
});

// ADR-0037 phase 2 — the LINK that phase 1 was missing. The annotator produced
// a value that every consumer then stripped, because `handoffPacketSchema`
// drops unknown keys. These assert the two ends agree, so the annotation
// actually survives the round trip to a reader.
describe("the annotation survives the read schema", () => {
  it("parses through annotatedHandoffPacketSchema with flakiness INTACT", async () => {
    const { annotatedHandoffPacketSchema } = await import("@muon/protocol");
    const [out] = await read.annotateHandoffChecks(
      [
        {
          packetJson: {
            taskGoal: "goal",
            whatChanged: "changed",
            whatFailed: "failed",
            nextLaneRequest: "next",
            commandsRun: [],
            checksStatus: [],
            openQuestions: [],
            provenance: { lane: "codex", createdAt: "2026-08-07T00:00:00.000Z" },
            checks: [{ name: "npm test", outcome: "failed", summary: "" }],
          },
        },
      ],
      REPO_A
    );
    const parsed = annotatedHandoffPacketSchema.safeParse(out!.packetJson);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const check = parsed.data.checks[0]!;
    // Repo A's `npm test` is 1-of-4 failing — the field notes' exact case.
    expect(check.flakiness?.kind).toBe("flaky");
    expect(check.flakinessNote).toContain("known-flaky");
    // D1 holds across the round trip: the outcome is untouched.
    expect(check.outcome).toBe("failed");
  });

  it("is STRIPPED by the agent-write schema, so a packet cannot forge one", async () => {
    // The security property behind keeping two schemas. An agent submitting a
    // packet cannot even express `flakiness`: the write-side schema does not
    // name it, so zod drops it before anything reads it. `stripClaimedFlakiness`
    // is defence in depth, not the first line.
    const { handoffPacketSchema } = await import("@muon/protocol");
    const forged = handoffPacketSchema.parse({
      taskGoal: "goal",
      whatChanged: "changed",
      whatFailed: "failed",
      nextLaneRequest: "next",
      commandsRun: [],
      checksStatus: [],
      openQuestions: [],
      provenance: { lane: "codex", createdAt: "2026-08-07T00:00:00.000Z" },
      checks: [
        {
          name: "npm test",
          outcome: "failed",
          summary: "",
          flakiness: { kind: "flaky", runs: 99, failures: 1 },
          flakinessNote: "known-flaky: failed 1 of 99 recorded runs",
        },
      ],
    });
    expect(JSON.stringify(forged)).not.toContain("99");
    expect(forged.checks[0]).not.toHaveProperty("flakiness");
    expect(forged.checks[0]!.outcome).toBe("failed");
  });
});

// The index that makes this read cheap. Asserted through EXPLAIN QUERY PLAN
// rather than a timing, because a timing on an empty test DB proves nothing and
// a plan assertion fails loudly the moment someone drops the index.
describe("the check-history read is indexed", () => {
  it("seeks on workspacePath and needs no temp sort", async () => {
    const plan: { detail: string }[] = await db.prisma.$queryRawUnsafe(
      "EXPLAIN QUERY PLAN SELECT * FROM DispatchJob WHERE workspacePath = ? AND status IN (?,?,?) ORDER BY createdAt DESC LIMIT 60",
      REPO_A,
      "done",
      "failed",
      "interrupted"
    );
    const detail = plan.map((row) => row.detail).join(" | ");
    expect(detail).toContain("DispatchJob_workspacePath_createdAt_idx");
    // Before the index the planner seeked on `status` — reading every matching
    // row across EVERY workspace — and then built a sort. `status` is an IN over
    // three of five lifecycle values, so [status, createdAt] cannot serve the
    // ordering. The absence of this line is the actual win.
    expect(detail).not.toContain("TEMP B-TREE");
  });
});
