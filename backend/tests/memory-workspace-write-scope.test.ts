import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// ADR-0026 §11 STEP 2 — the WRITE path, with real SQLite, the real LadybugDB
// graph and the real HTTP routes. Three things are proven here, and the third is
// as important as the first two:
//
//   1. DERIVATION. The partition comes from the authenticated
//      `AgentJobCapability.workspacePath` (server-side, from `DispatchJob`),
//      reduced by `repoRootOf` — never from a request body, and never from
//      `MUON_WORKSPACE`, which the runner remaps to the governed worktree.
//   2. BOTH DEDUP KEYS ARE PARTITIONED. This is why step 2 must ship BEFORE the
//      read fence: `findExactTextDuplicate` and `anchorScopedCandidates` both had
//      CONDITIONAL chat clauses, so two repos' identical notes collapsed into one
//      row. Fence the reads first and that survivor is then correctly fenced into
//      ONE workspace, LOSING the other repo's copy — worse than the leak.
//   3. READS ARE UNCHANGED. Step 2 must be behaviour-neutral for every reader, so
//      the last test stamps a whole corpus and asserts every read surface returns
//      the identical ordered set it returned before.

const OPERATOR = "operator-token-ws-write";
const AGENT = "agent-token-ws-write";
const JOB_A_TOKEN = `job-wsa-${"a".repeat(56)}`;
const JOB_A_WORKTREE_TOKEN = `job-wsw-${"w".repeat(56)}`;
const JOB_B_TOKEN = `job-wsb-${"b".repeat(56)}`;
const JOB_NOWS_TOKEN = `job-wsn-${"n".repeat(56)}`;
const MOD = "src/pay/charge.ts";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let workspaceA: string;
let workspaceB: string;
let worktreeInA: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-ws-write-")));
  workspaceA = path.join(dir, "repo-a");
  workspaceB = path.join(dir, "repo-b");
  // The exact shape `execute.ts` hands a worker under an editing harness.
  worktreeInA = path.join(workspaceA, ".muon", "worktrees", "task-worktree");
  mkdirSync(worktreeInA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });

  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();

  const job = (
    id: string,
    taskId: string,
    chatId: string,
    workspacePath?: string
  ) => ({
    id,
    kind: "oneshot",
    vendor: "codex",
    taskId,
    chatId,
    brief: `${id} memory job`,
    status: "running",
    dispatchedBy: "human",
    ...(workspacePath ? { workspacePath } : {}),
  });
  await db.prisma.dispatchJob.createMany({
    data: [
      job("job-ws-a", "task-ws-a", "chat-WS-A", workspaceA),
      // A second workspace. It gets its own chat because
      // `DispatchJob_one_active_root_per_chat` forbids two running root jobs in
      // one chat — which is exactly why the dedup tests below call the ledger
      // DIRECTLY with one shared chatId: that is the only way to isolate the
      // workspace axis from the chat axis that already fences these queries.
      job("job-ws-b", "task-ws-b", "chat-WS-B", workspaceB),
      job("job-ws-worktree", "task-worktree", "chat-WS-W", worktreeInA),
      job("job-ws-none", "task-ws-none", "chat-WS-N"),
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-ws-a", JOB_A_TOKEN],
      ["job-ws-b", JOB_B_TOKEN],
      ["job-ws-worktree", JOB_A_WORKTREE_TOKEN],
      ["job-ws-none", JOB_NOWS_TOKEN],
    ].map(([jobId, token]) => ({
      jobId: jobId!,
      tokenHash: createHash("sha256").update(token!).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await graphLib?.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function postNote(
  token: string,
  body: Record<string, unknown>
): Promise<{ id: string; action: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/memory",
    headers: auth(token),
    // `createdBy` is required by the schema and then DERIVED FROM AUTH for the
    // agent tier (an agent claiming "human:*" is downgraded), so passing it here
    // exercises the real shape without weakening anything.
    payload: { createdBy: "human", ...body },
  });
  expect(response.statusCode).toBe(201);
  const json = response.json();
  return { id: json.note.id, action: json.action };
}

const rowOf = (id: string) =>
  db.prisma.memoryNote.findUniqueOrThrow({ where: { id } });

describe("ADR-0026 step 2: the write path derives and stores the workspace", () => {
  it("DERIVATION: an agent write lands on the capability's workspace, not on anything the body says", async () => {
    const written = await postNote(JOB_A_TOKEN, {
      kind: "decision",
      text: "Charges are idempotent by request key whiskey-alpha",
      modules: [MOD],
      // A caller CLAIM. `createNoteSchema` has no such field, so this is dropped
      // at the boundary; the derived value is the only one that can ever land.
      workspacePath: workspaceB,
    });
    const row = await rowOf(written.id);
    expect(row.workspacePath).toBe(workspaceA);
    expect(row.chatId).toBe("chat-WS-A");
  });

  it("WORKTREE: a job executing in .muon/worktrees/<taskId> lands on the PARENT repo", async () => {
    // Without `repoRootOf` this write would mint one memory island per dispatch,
    // by construction, on the most common code path (§4).
    const written = await postNote(JOB_A_WORKTREE_TOKEN, {
      kind: "convention",
      text: "Worktree jobs still write to the parent repo brain xray-bravo",
      modules: [MOD],
    });
    expect((await rowOf(written.id)).workspacePath).toBe(workspaceA);
  });

  it("MUON_WORKSPACE IS NOT THE SOURCE: the env var cannot move the partition", async () => {
    const previous = process.env.MUON_WORKSPACE;
    process.env.MUON_WORKSPACE = workspaceB;
    try {
      const written = await postNote(JOB_A_TOKEN, {
        kind: "constraint",
        text: "The env var is a display coordinate, not the partition yankee-charlie",
        modules: [MOD],
      });
      expect((await rowOf(written.id)).workspacePath).toBe(workspaceA);
    } finally {
      if (previous === undefined) {
        delete process.env.MUON_WORKSPACE;
      } else {
        process.env.MUON_WORKSPACE = previous;
      }
    }
  });

  it("RESIDUE: a job with no workspace, and an operator write, both land NULL", async () => {
    const fromJob = await postNote(JOB_NOWS_TOKEN, {
      kind: "attempt",
      text: "A job with no bound workspace zulu-delta",
      modules: [MOD],
    });
    expect((await rowOf(fromJob.id)).workspacePath).toBeNull();

    const fromOperator = await postNote(OPERATOR, {
      kind: "decision",
      text: "An operator write has no derived workspace alpha-echo",
      modules: [MOD],
      workspacePath: workspaceA,
    });
    expect((await rowOf(fromOperator.id)).workspacePath).toBeNull();
  });

  it("ANCHOR: a kind:workspace anchor row is emitted, and none for the residue", async () => {
    const scoped = await postNote(JOB_B_TOKEN, {
      kind: "decision",
      text: "Repo B keeps its own anchor row bravo-foxtrot",
      modules: [MOD],
    });
    const residue = await postNote(JOB_NOWS_TOKEN, {
      kind: "decision",
      text: "The residue has no workspace anchor charlie-golf",
      modules: [MOD],
    });
    expect(
      await db.prisma.memoryAnchor.findMany({
        where: { noteId: scoped.id, kind: "workspace" },
        select: { value: true },
      })
    ).toEqual([{ value: workspaceB }]);
    expect(
      await db.prisma.memoryAnchor.count({
        where: { noteId: residue.id, kind: "workspace" },
      })
    ).toBe(0);
  });

  it("GRAPH MIRROR: the partition round-trips through the projection", async () => {
    const written = await postNote(JOB_B_TOKEN, {
      kind: "constraint",
      text: "The mirror carries the partition delta-hotel",
      modules: [MOD],
    });
    await ledger.projectLedgerToGraph();
    const mirrored = await graphLib.getGraph().getMemoryNote(written.id);
    expect(mirrored?.workspacePath).toBe(workspaceB);
  });
});

describe("ADR-0026 step 2: BOTH dedup keys are workspace-partitioned", () => {
  // Direct ledger calls, because the axis under test has to be isolated: the same
  // `chatId` on both sides, so only `workspacePath` differs. The route path is
  // covered above.
  const ingest = (text: string, workspacePath: string | undefined, modules: string[] = [MOD]) =>
    ledger.ingestMemoryNote({
      kind: "decision",
      text,
      createdBy: "human",
      chatId: "chat-dedup",
      modules,
      ...(workspacePath ? { workspacePath } : {}),
    });

  it("EXACT TEXT: the same sentence in two repos stays TWO rows, and collapses within one", async () => {
    const text = "Retries use exponential backoff with jitter echo-india";
    const first = await ingest(text, workspaceA);
    const second = await ingest(text, workspaceB);
    const restated = await ingest(text, workspaceA);

    expect(first.action).toBe("inserted");
    // THE cross-workspace merge fix. Before ADR-0026 this returned "duplicate"
    // and repo B was left with no copy of its own fact at all.
    expect(second.action).toBe("inserted");
    expect(second.note.id).not.toBe(first.note.id);
    // Within ONE workspace the idempotency still holds, unchanged.
    expect(restated.action).toBe("duplicate");
    expect(restated.note.id).toBe(first.note.id);
  });

  it("EXACT TEXT: an unassigned write keeps today's global dedup (the conditional shape)", async () => {
    const text = "Unassigned writes keep global dedup foxtrot-juliet";
    const first = await ingest(text, undefined);
    const second = await ingest(text, undefined);
    expect(first.action).toBe("inserted");
    expect(second.action).toBe("duplicate");
  });

  it("ANCHOR CANDIDATES: a same-anchor near-duplicate in another repo is not a candidate", async () => {
    const mod = "src/anchor/scope.ts";
    const original = await ingest(
      "Payment webhooks are verified with the shared secret golf-kilo",
      workspaceA,
      [mod]
    );
    // Same anchor, same chat, REFINING text — the shape that supersedes within a
    // workspace. Across workspaces it must not touch repo A's note at all.
    const other = await ingest(
      "Payment webhooks are verified with the shared secret golf-kilo, rotated monthly",
      workspaceB,
      [mod]
    );
    expect(other.action).toBe("inserted");
    expect(
      (await rowOf(original.note.id)).status
    ).toBe("active");
    expect((await rowOf(original.note.id)).supersededBy).toBeNull();
  });

  it("PROPAGATION: a clone and a text-edit successor both stay in the source's workspace", async () => {
    const source = await ingest(
      "Idempotency keys live for 24 hours hotel-lima",
      workspaceA
    );
    const cloned = await ledger.cloneMemoryNote(source.note.id, {
      tier: "operator",
      principal: "human",
    });
    expect(cloned.status).toBe("cloned");
    if (cloned.status === "cloned") {
      expect((await rowOf(cloned.note.id)).workspacePath).toBe(workspaceA);
    }

    const edited = await ledger.updateMemoryNote(source.note.id, {
      text: "Idempotency keys live for 48 hours hotel-lima",
    });
    expect(edited).not.toBeNull();
    expect((await rowOf(edited!.id)).workspacePath).toBe(workspaceA);
  });
});

// ADR-0026 §5 MONOTONICITY. This block began life as step 2's "reads are
// UNCHANGED" proof. Step 3 fenced the reads, so the claim narrows to the one it can
// still make — and the one §5 actually requires: **a read that sends NO workspace
// coordinate behaves exactly as it did before the column existed.** That is what
// makes the rollout monotonic, what keeps every pre-ADR HTTP caller working, and why
// a surface that forgets the predicate is an unclosed hole rather than a new leak.
//
// The two AGENT probes moved out, deliberately: their coordinate is now DERIVED from
// the capability on every request, so they can never be coordinate-less again. Their
// both-directions fence is asserted in `memory-workspace-read-scope.test.ts`.
describe("ADR-0026 §5: an UNSCOPED read is byte-for-byte unchanged", () => {
  it("every coordinate-less read surface returns the identical ordered set before and after the corpus is partitioned", async () => {
    // A corpus that spans both workspaces AND the unassigned residue, confirmed so
    // the hero gate admits it, anchored on one module so recall/search both hit.
    const mod = "src/read/unchanged.ts";
    const ids: string[] = [];
    for (const [index, word] of ["india", "juliet", "kilo", "lima"].entries()) {
      const id = `mem-read-unchanged-${index}`;
      await db.prisma.$transaction([
        db.prisma.memoryNote.create({
          data: {
            id,
            kind: "decision",
            text: `Read-path invariance probe ${word} november-oscar`,
            textHash: `read-unchanged-${index}`,
            scope: "project",
            trust: "high",
            status: "active",
            createdBy: "human",
            taskId: "task-read-unchanged",
            chatId: "chat-WS-A",
            modules: [mod],
            topics: [],
            symbols: [],
          },
        }),
        db.prisma.confirmation.create({
          data: { noteId: id, principal: "human", decision: "confirm" },
        }),
      ]);
      ids.push(id);
    }
    await ledger.projectLedgerToGraph();

    const probes: { label: string; url: string; token: string }[] = [
      {
        label: "operator search",
        url: "/api/memory/search?q=november-oscar",
        token: OPERATOR,
      },
      {
        label: "operator recall",
        url: "/api/memory/recall?taskId=task-read-unchanged",
        token: OPERATOR,
      },
      {
        label: "operator library",
        url: "/api/memory/library?limit=200",
        token: OPERATOR,
      },
      {
        label: "operator analytics",
        url: "/api/memory/analytics",
        token: OPERATOR,
      },
    ];
    const read = async () => {
      const out: Record<string, unknown[]> = {};
      for (const probe of probes) {
        const response = await app.inject({
          method: "GET",
          url: probe.url,
          headers: auth(probe.token),
        });
        expect(response.statusCode).toBe(200);
        // `/analytics` has no `notes` key at all — it is coordinate-only — so the
        // whole body is the comparand there. Included precisely BECAUSE it has a
        // different shape: it is a read surface, and step 3 gave it the predicate.
        const body = response.json() as Record<string, unknown>;
        const notes = body.notes as Record<string, unknown>[] | undefined;
        out[probe.label] = notes
          ? notes.map((note) => {
              // The column is the ONE legitimate difference: strip it and every
              // remaining byte, and the ORDER, must be identical.
              const { workspacePath: _workspacePath, ...rest } = note;
              return rest;
            })
          : [body];
      }
      return out;
    };

    const before = await read();

    // Now partition the whole corpus: two workspaces plus one deliberate residue.
    // RAW SQL on purpose. A Prisma `update` would bump `@updatedAt`, and the whole
    // claim of this test is that the ONLY thing that changed about these rows is
    // the new column.
    for (const [id, workspacePath] of [
      [ids[0]!, workspaceA],
      [ids[1]!, workspaceB],
      [ids[2]!, workspaceB],
    ] as const) {
      await db.prisma.$executeRawUnsafe(
        `UPDATE "MemoryNote" SET "workspacePath" = ? WHERE "id" = ?`,
        workspacePath,
        id
      );
    }
    await ledger.projectLedgerToGraph();

    const after = await read();
    expect(after).toEqual(before);
    // And the sets are non-empty, so this is not a vacuous pass.
    for (const probe of probes) {
      expect(before[probe.label]!.length).toBeGreaterThan(0);
    }
  });
});

describe("ADR-0026 step 2: the operator residue backfill", () => {
  it("is DRY-RUN by default, reports the three counts, and only writes when told to", async () => {
    // A resolvable residue note (its Task witness exists) plus one with no witness.
    await db.prisma.task.create({
      data: {
        id: "task-backfill-witness",
        title: "witness",
        description: "witness",
        workspacePath: workspaceB,
      },
    });
    await db.prisma.memoryNote.createMany({
      data: [
        {
          id: "mem-backfill-resolvable",
          kind: "decision",
          text: "Resolvable residue papa-quebec",
          textHash: "backfill-resolvable",
          createdBy: "human",
          taskId: "task-backfill-witness",
          modules: [],
          topics: [],
          symbols: [],
        },
        {
          id: "mem-backfill-orphan",
          kind: "decision",
          text: "Unresolvable residue romeo-sierra",
          textHash: "backfill-orphan",
          createdBy: "human",
          modules: [],
          topics: [],
          symbols: [],
        },
      ],
    });

    const dryRun = await app.inject({
      method: "POST",
      url: "/api/memory/backfill-workspace",
      headers: auth(OPERATOR),
      payload: {},
    });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json().applied).toBe(false);
    expect(dryRun.json().byWorkspace).toEqual(
      expect.arrayContaining([{ workspacePath: workspaceB, notes: 1 }])
    );
    expect(dryRun.json().noWitness).toBeGreaterThan(0);
    // A dry run writes NOTHING.
    expect(
      (await rowOf("mem-backfill-resolvable")).workspacePath
    ).toBeNull();

    const applied = await app.inject({
      method: "POST",
      url: "/api/memory/backfill-workspace",
      headers: auth(OPERATOR),
      payload: { apply: true },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().applied).toBe(true);
    expect((await rowOf("mem-backfill-resolvable")).workspacePath).toBe(
      workspaceB
    );
    expect(
      await db.prisma.memoryAnchor.findMany({
        where: { noteId: "mem-backfill-resolvable", kind: "workspace" },
        select: { value: true },
      })
    ).toEqual([{ value: workspaceB }]);
    // The witness-less note is never guessed at.
    expect((await rowOf("mem-backfill-orphan")).workspacePath).toBeNull();
  });

  it("is OPERATOR-ONLY", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/backfill-workspace",
      headers: auth(JOB_A_TOKEN),
      payload: { apply: true },
    });
    expect(response.statusCode).toBe(403);
  });
});
